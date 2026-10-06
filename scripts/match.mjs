#!/usr/bin/env node
// Chunk 1, the deterministic half: decide which Slack hits are real, new, actionable tags. (Was slack-scan.js.)
// The model fetches Slack data with its MCP tools and passes the raw material in; this script applies the team's
// rules and the ledger. It never decides "this looks like a tag" by eye.
//
//   node scripts/match.mjs --team remex --file hits.json [--now <unix seconds>]
//   cat hits.json | node scripts/match.mjs --team remex
//
// Input JSON:
// { "hits": [ { "ts": "1789182002.083939", "threadTs": "1789182000.148269", "channelId": "C0K4U8ZS7", "text": "<raw text>",
//               "user": "UKT3PK4NM", "permalink": "https://…" } ],
//   "threads": { "<threadTs>": [ { "ts": "…", "text": "<raw text>", "user": "…" }, … ] } }
// Output JSON (candidates.json): { team, window, candidates: [ {ts, threadTs, channelId, permalink, tokens, alertCode, kibanaLinks, tagger, ageMinutes} ],
//                                  skipped: [ {ts, reason} ], watermarkTs }
// Rules, in order: token present (in the hit or in its own thread message) → not only an ignored subteam →
// not already handled/replied → not stale → alert-like (SRE code or Kibana link in the thread) → not an excluded alert code → cap.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT, readInput } from "./lib/cli.mjs";
import { readJsonIf } from "./lib/io.mjs";
import { resolve, pickTeam } from "./config.mjs";
import { HANDLED } from "./ledger.mjs";

const KIBANA = /https?:\/\/kibana\.[a-z0-9.-]+\/(app\/(discover|r\b|r\/s\/|kibana#\/discover)|goto\/[A-Za-z0-9_-]+)/;
const SRE = /\[(SRE\d{4})\]/;

export function unescape(t) { return String(t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }

/**
 * Alert key: what makes two tags "the same alert". SRE code or quoted title, plus the service named in the text.
 * Used to analyse one service+title once per skip.repeatWindowHours and to group repeats inside a run.
 */
export function alertKeyOf(allText) {
  const t = unescape(allText);
  const code = (t.match(/\[(SRE\d{4})\]/) || [])[1];
  const quoted = (t.match(/'([^'\n]{4,120})'/) || [])[1];
  const title = (code || quoted || (t.split("\n").find(l => l.trim()) || "").replace(/<[^>]+>/g, "").trim().slice(0, 80)).toLowerCase();
  const svc = (t.match(/Service name:\s*\*?([a-z0-9.-]+)/i) || t.match(/Detected for:\s*\*?([a-z0-9.-]+)/i) || t.match(/\|\s*([a-z0-9.-]+)\*?\s*$/m) || [])[1];
  return `${title}::${(svc || "").toLowerCase()}`;
}

/** Pure function so tests can drive it without a state dir. */
export function matchCandidates(cfg, ledger, input, nowSec = Date.now() / 1000) {
  const tokens = cfg.derived.matchTokens;
  const ignored = (cfg.slack.ignoreSubteamIds || []).map(id => `<!subteam^${id}`);
  const sig = (cfg.output || {}).signature || "";
  const skip = cfg.skip || {};
  const staleH = skip.olderThanHours || 48;
  const maxPerRun = (cfg.poll || {}).maxPerRun || 5;
  const repeatH = skip.repeatWindowHours === undefined ? 24 : Number(skip.repeatWindowHours);   // 0 disables the suppression
  const processed = ledger.processed || {}, replied = ledger.repliedThreads || {};
  // alert keys already analysed (posted/team-only/dm/draft) inside the repeat window
  const recentKeys = new Map();
  if (repeatH > 0) for (const [ts, e] of Object.entries(processed)) {
    if (!e.alertKey || !HANDLED.has(e.status) || e.status === "skipped") continue;
    const at = e.processedAt ? Date.parse(e.processedAt) / 1000 : Number(ts);
    if (nowSec - at <= repeatH * 3600) recentKeys.set(e.alertKey, { ts, ticket: e.ticket || null, status: e.status });
  }

  const candidates = [], skipped = [];
  const seenThreads = new Set();
  const seenKeys = new Map();   // alertKey → candidate (grouping inside this run)
  const hits = [...(input.hits || [])].sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const h of hits) {
    const threadTs = h.threadTs || h.ts;
    const thread = (input.threads || {})[threadTs] || [];
    const own = thread.find(m => m.ts === h.ts);
    const text = unescape(h.text || (own && own.text) || "");
    const found = tokens.filter(t => text.includes(t));
    if (!found.length) { skipped.push({ ts: h.ts, reason: "no match token in the message" }); continue; }
    // A token that only occurs inside an ignored group's mention (<!subteam^S…|handle>) does not count.
    const withoutIgnored = ignored.reduce((s, ig) => s.replace(new RegExp(ig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^>]*>", "g"), ""), text);
    if (ignored.length && !tokens.some(t => withoutIgnored.includes(t))) { skipped.push({ ts: h.ts, reason: "only an ignored user group is tagged" }); continue; }
    const prev = processed[h.ts];
    if (prev && HANDLED.has(prev.status)) { skipped.push({ ts: h.ts, reason: `already handled (${prev.status})` }); continue; }
    if (replied[threadTs]) { skipped.push({ ts: h.ts, reason: "thread already replied (ledger)" }); continue; }
    if (sig && thread.some(m => unescape(m.text).startsWith(sig.slice(0, 40)))) { skipped.push({ ts: h.ts, reason: "thread already replied (signature found)" }); continue; }
    if (seenThreads.has(threadTs)) { skipped.push({ ts: h.ts, reason: "same thread already a candidate in this run" }); continue; }
    if (nowSec - Number(h.ts) > staleH * 3600) { skipped.push({ ts: h.ts, reason: `stale (> ${staleH} h)` }); continue; }
    const allText = [text, ...thread.map(m => unescape(m.text))].join("\n");
    const codeM = allText.match(SRE);
    const kibanaLinks = [...new Set((allText.match(/https?:\/\/kibana\.[^\s|>]+/g) || []))];
    if (skip.nonAlertMentions !== false && !codeM && !KIBANA.test(allText)) { skipped.push({ ts: h.ts, reason: "non-alert mention (no SRE code, no Kibana link)" }); continue; }
    if (codeM && (skip.alertCodes || []).includes(codeM[1])) { skipped.push({ ts: h.ts, reason: `alert code ${codeM[1]} excluded by config` }); continue; }
    const alertKey = alertKeyOf(allText);
    if (repeatH > 0) {
      const prev = recentKeys.get(alertKey);
      if (prev) { skipped.push({ ts: h.ts, reason: `same alert+service analysed ${prev.ticket ? prev.ticket + " " : ""}within ${repeatH} h (ts ${prev.ts})`, alertKey, repeatOf: prev.ts }); continue; }
      const grouped = seenKeys.get(alertKey);
      if (grouped) { grouped.repeats.push(h.ts); skipped.push({ ts: h.ts, reason: `grouped with ${grouped.ts} (same alert+service in this run)`, alertKey, repeatOf: grouped.ts }); continue; }
    }
    seenThreads.add(threadTs);
    const cand = { ts: h.ts, threadTs, channelId: h.channelId, permalink: h.permalink || null, tokens: found, alertCode: codeM ? codeM[1] : null,
      kibanaLinks, tagger: h.user || null, ageMinutes: Math.round((nowSec - Number(h.ts)) / 60), alertKey, repeats: [] };
    seenKeys.set(alertKey, cand);
    candidates.push(cand);
  }
  const capped = candidates.slice(0, maxPerRun);
  const deferred = candidates.slice(maxPerRun);
  for (const c of deferred) skipped.push({ ts: c.ts, reason: `deferred to next run (maxPerRun ${maxPerRun})`, deferred: true, alertKey: c.alertKey });
  return { team: cfg.team, candidates: capped, skipped, watermarkTs: ledger.watermarkTs || null,
    deferredOldestTs: deferred.length ? deferred[0].ts : null, repeatWindowHours: repeatH,
    watermarkAdvanceHint: deferred.length ? `advance to ${(Number(deferred[0].ts) - 0.000001).toFixed(6)} at most, so deferred candidates are found next run` : "advance to now − searchLagMinutes" };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("match", e.message, EXIT.USAGE); }
  const input = readInput(opt.file);
  const ledger = readJsonIf(cfg.ledgerPath, { processed: {}, repliedThreads: {} });
  const nowSec = opt.now ? Number(opt.now) : Date.now() / 1000;
  const result = matchCandidates(cfg, ledger, input, nowSec);
  result.window = input.window || null;
  out(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
