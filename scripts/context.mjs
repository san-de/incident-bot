#!/usr/bin/env node
// Chunk 2: build context.json for one candidate from the thread the model already fetched. No credential, no model.
//
//   node scripts/context.mjs --team remex --candidate cand.json --thread thread.json [--env prod] [--now ISO]
//   candidate: one entry of candidates.json (ts, threadTs, channelId, permalink, alertCode, kibanaLinks, tagger)
//   thread:    [{ts, text, user, botName?}, …] oldest first (the parent first)
//
// Output: { service_name, error_id, trace_id, alert_code, title, signature_hint, window_utc{from,to,source}, deploy_anchor{at,source,release,job},
//           repo, repo_source, links{kibana,jira,grafana,jenkins,cockpit}, thread_excerpt[], permalink, tagger, gaps[] }
// Rules: the tagged message's own Kibana link wins, then the SRE reply's, then the parent's. No window from any link →
// [message_time − fallbackWindowMinutes, message_time + fallbackWindowMinutes]. Windows are capped at kibana.maxWindowHours.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { readJson, readJsonIf } from "./lib/io.mjs";
import { resolve, pickTeam } from "./config.mjs";
import { resolveAny, unslack } from "./links.mjs";
import { redact } from "./lib/redact.mjs";

const unesc = t => String(t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function lookupRepo(serviceName, catalogue, overlay) {
  const all = Object.assign({}, (catalogue || {}).services || {}, (overlay || {}).services || {});
  if (!serviceName) return { repo: null, source: "none" };
  if (all[serviceName]) return { repo: all[serviceName].repo, source: overlay && overlay.services && overlay.services[serviceName] ? "overlay" : "catalogue", entry: all[serviceName] };
  const short = serviceName.replace(/-service$/, "");
  if (all[short]) return { repo: all[short].repo, source: "catalogue:short", entry: all[short] };
  return { repo: null, source: "none" };
}

/** Unmapped service → the name to try first when discovering the repo (wkda convention: <service>-service). Never trusted, only a hint. */
export function repoGuess(serviceName, orgs = ["wkda"]) {
  if (!serviceName) return [];
  const base = serviceName.replace(/-service$/, "");
  return orgs.flatMap(o => [`${o}/${base}-service`, `${o}/${base}`]);
}

export function extractFacts(thread) {
  const facts = { service: null, errorId: null, traceId: null, title: null, links: {}, deploy: null, jira: null, frames: [], exception: null };
  for (const m of thread) {
    const t = unesc(m.text);
    const det = t.match(/Detected for:\s*\*?([a-z0-9.-]+)\*?/i) || t.match(/Service name:\s*\*?([a-z0-9.-]+)\*?/i); if (det && !facts.service) facts.service = det[1];
    const eid = t.match(/Error id:\s*\*?([0-9a-f]{6,})\*?/i); if (eid && !facts.errorId) facts.errorId = eid[1];
    const tid = t.match(/trace\.id[`: *]+([0-9a-f]{12,})/i); if (tid && !facts.traceId) facts.traceId = tid[1];
    const ttl = t.match(/\[(SRE\d{4})\]:?\s*([^|\n*]+)/) || t.match(/^\s*'([^'\n]{4,120})'/); if (ttl && !facts.title) facts.title = (ttl[2] || ttl[1]).trim().slice(0, 140);
    if (/Last deployment/i.test(t) && !facts.deploy) {
      const line = (t.split("\n").find(l => /Last deployment/i.test(l)) || t);
      const ago = (line.match(/(\d+\s*(?:minutes?|hours?|days?)\s*ago)/i) || [])[1] || null;
      const job = (line.match(/<(https?:[^|>]*jenkins[^|>]*)/i) || line.match(/<(https?:[^|>]+)/) || [])[1] || null;
      const release = (line.match(/\b(?:release|tag|version)[: ]*([vV]?\d+\.\d+\.\d+[\w.-]*)/i) || line.match(/\b(v\d+\.\d+\.\d+[\w.-]*)\b/) || [])[1] || null;
      facts.deploy = { ago, job, release, messageTs: m.ts };
    }
    const jira = t.match(/\b([A-Z][A-Z0-9]+-\d{2,6})\b/); if (jira && !facts.jira && /jira|atlassian|:jira:/i.test(t)) facts.jira = jira[1];
    for (const u of t.match(/https?:\/\/[^\s|>]+/g) || []) {
      if (/kibana\./.test(u) && !facts.links.kibana) facts.links.kibana = u;
      if (/grafana/.test(u) && !facts.links.grafana) facts.links.grafana = u;
      if (/jenkins/.test(u) && !facts.links.jenkins) facts.links.jenkins = u;
      if (/cockpit/.test(u) && !facts.links.cockpit) facts.links.cockpit = u;
      if (/atlassian\.net\/browse\//.test(u) && !facts.links.jira) facts.links.jira = u;
    }
    for (const line of t.split("\n")) {
      if (/\b(wkda|com\.auto1)\.[\w.$]+\([\w$]+\.java:\d+\)/.test(line) && facts.frames.length < 3) facts.frames.push(line.trim().replace(/^at\s+/, "").slice(0, 200));
      const ex = line.match(/\b([a-zA-Z_][\w.]*(?:Exception|Error))\b[: ]/); if (ex && !facts.exception) facts.exception = ex[1];
    }
  }
  return facts;
}

function agoToIso(ago, fromTs) {
  const m = String(ago || "").match(/(\d+)\s*(minute|hour|day)/i);
  if (!m) return null;
  const ms = { minute: 6e4, hour: 36e5, day: 864e5 }[m[2].toLowerCase()] * Number(m[1]);
  return new Date(Number(fromTs) * 1000 - ms).toISOString();
}

export async function buildContext(cfg, cand, thread, opts = {}) {
  const gaps = [];
  const env = (cfg.kibana || {}).env || "prod";
  const msgIso = new Date(Number(cand.ts) * 1000).toISOString();
  const facts = extractFacts(thread);
  const own = thread.find(m => m.ts === cand.ts);
  const ownLinks = own ? (unesc(own.text).match(/https?:\/\/kibana\.[^\s|>]+/g) || []) : [];
  const ordered = [...ownLinks, ...(cand.kibanaLinks || []), ...(facts.links.kibana ? [facts.links.kibana] : [])].filter((v, i, a) => a.indexOf(v) === i);

  let link = null, window = null;
  for (const u of ordered) {
    let r;
    try { r = opts.resolver ? await opts.resolver(u, msgIso, env) : await resolveAny(u, msgIso, env); }
    catch (e) { r = { error: `parse failed: ${String(e.message || e).slice(0, 80)}` }; }   // a malformed rison fragment must never abort the context
    if (r && !r.error) { link = Object.assign({ url: unslack(u) }, r); if (r.from && r.to) window = { from: r.from, to: r.to, source: `link:${r.shape}` }; break; }
    if (r && r.error) gaps.push(`kibana link not resolved (${r.error})`);
  }
  const fb = ((cfg.kibana || {}).fallbackWindowMinutes || 30) * 6e4;
  if (!window) window = { from: new Date(Date.parse(msgIso) - fb).toISOString(), to: new Date(Date.parse(msgIso) + fb).toISOString(), source: "fallback" };
  const maxH = ((cfg.kibana || {}).maxWindowHours || 6) * 36e5;
  if (Date.parse(window.to) - Date.parse(window.from) > maxH) {
    const mid = Date.parse(msgIso);
    window = { from: new Date(mid - maxH / 2).toISOString(), to: new Date(mid + maxH / 2).toISOString(), source: window.source + ":capped" };
    gaps.push(`window capped at ${maxH / 36e5} h around the alert`);
  }

  const service = (link && link.service) || facts.service || null;
  const catalogue = readJsonIf(cfg.servicesPath, { services: {} });
  const overlay = readJsonIf(cfg.overlayPath, { services: {} });
  const repo = lookupRepo(service, catalogue, overlay);
  if (!service) gaps.push("service not identified from thread or link");
  if (service && !repo.repo) gaps.push(`no repo mapping for ${service} (git-correlate will try discovery)`);
  if (!link && ordered.length === 0) gaps.push("no Kibana link in thread");

  const deploy = facts.deploy ? { at: agoToIso(facts.deploy.ago, facts.deploy.messageTs), source: "sre-reply", release: facts.deploy.release, job: facts.deploy.job } : { at: null, source: "none", release: null, job: null };

  return {
    team: cfg.team, ts: cand.ts, thread_ts: cand.threadTs, channel_id: cand.channelId, permalink: cand.permalink || null, tagger: cand.tagger || null,
    alert_code: cand.alertCode || null, title: facts.title, service_name: service,
    error_id: (link && link.errorId) || facts.errorId || null, trace_id: (link && link.traceId) || facts.traceId || null,
    signature_hint: facts.exception ? `${facts.exception}${facts.frames[0] ? " at " + facts.frames[0] : ""}` : null, frames: facts.frames,
    window_utc: window, message_time_utc: msgIso, deploy_anchor: deploy,
    repo: repo.repo, repo_source: repo.source, repo_guess: repo.repo ? [] : repoGuess(service, (cfg.github || {}).orgs),
    alert_key: cand.alertKey || null, repeats: cand.repeats || [],
    known_issues: (repo.entry && repo.entry.knownIssues) || [], known_noise: (repo.entry && repo.entry.knownNoise) || [],
    links: Object.assign({}, facts.links, link ? { kibana: link.url, kibana_resolved: link.resolvedUrl || null } : {}),
    kibana_filters: link ? { kql: link.kql, levels: link.levels, filters: link.filters } : null,
    thread_excerpt: thread.slice(0, 12).map(m => ({ ts: m.ts, user: m.user || m.botName || null, text: redact(unesc(m.text)).slice(0, 400) })),
    gaps,
  };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("context", e.message, EXIT.USAGE); }
  if (!opt.candidate || !opt.thread) fail("context", "usage: context.mjs --team <team> --candidate cand.json --thread thread.json", EXIT.USAGE);
  const cand = readJson(opt.candidate), thread = readJson(opt.thread);
  out(await buildContext(cfg, cand, Array.isArray(thread) ? thread : thread.messages || []));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
