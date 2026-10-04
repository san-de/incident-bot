#!/usr/bin/env node
// Chunk 6, first half: render report.json into the fixed Slack and Jira texts. Templates live in templates/*.md;
// change them, not the skill prose, to change what gets posted. Every rendered text goes through redact().
//
//   node scripts/render.mjs thread --team remex --report report.json --context context.json
//   node scripts/render.mjs team   --team remex --report report.json --context context.json --reply-ts 1789354900.000100
//   node scripts/render.mjs dm     --team remex --report report.json --context context.json
//   node scripts/render.mjs jira   --team remex --report report.json --context context.json
//
// Output: { kind, text, chars, truncated, max }. Thread text is trimmed to output.maxChars: Evidence first, then Where.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { readJson } from "./lib/io.mjs";
import { resolve, pickTeam, REPO_ROOT } from "./config.mjs";
import { redact } from "./lib/redact.mjs";

const BERLIN = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
export function berlin(iso) { if (!iso) return "?"; try { return BERLIN.format(new Date(iso)).replace(",", ""); } catch { return iso; } }
export function permalink(ws, channel, ts, threadTs) {
  const p = `${ws}/archives/${channel}/p${String(ts).replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
}

/** {{a.b}} placeholders; missing → "" ; {{#if x}}…{{/if}} blocks. */
export function fill(template, vars) {
  const get = k => k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), vars);
  return template
    .replace(/\{\{#if ([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, k, body) => { const v = get(k); return v && !(Array.isArray(v) && !v.length) ? body : ""; })
    .replace(/\{\{([\w.]+)\}\}/g, (_, k) => { const v = get(k); return v == null ? "" : Array.isArray(v) ? v.join(" · ") : String(v); });
}

export function loadTemplate(name) {
  const file = path.join(REPO_ROOT, "templates", `${name}.md`);
  const md = fs.readFileSync(file, "utf8");
  const m = md.match(/```text\n([\s\S]*?)```/);
  if (!m) throw new Error(`template ${name}.md has no \`\`\`text block`);
  return m[1].replace(/\n$/, "");
}

export function buildVars(cfg, report, ctx, extra = {}) {
  const ws = (cfg.slack || {}).workspaceUrl || "https://slack.com";
  const r = report, k = r.kibana || {}, g = r.git || {}, s0 = (g.suspects || [])[0] || null;
  return {
    signature: (cfg.output || {}).signature || "",
    team: cfg.team, alert_code: ctx.alert_code || "alert", service: k.service || ctx.service_name || "?",
    classification: r.classification || "unknown", what: r.what || r.summary || "", read: r.read || "", proposal: r.next_action || "",
    where: r.where || null, evidence: (r.evidence || []).map(e => `• ${e}`).join(" "), open_points: r.open_points || "none",
    gaps: (r.gaps || []).concat(ctx.gaps || []).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "none",
    count: k.count, window: k.window_utc || `${ctx.window_utc.from}..${ctx.window_utc.to}`, signature_line: k.signature || "",
    suspect: s0 ? `${s0.ref} "${s0.title}" (${s0.why})` : null, repo: g.repo || ctx.repo || null, last_deploy: g.last_deploy || (ctx.deploy_anchor || {}).at || null,
    tagger: ctx.tagger ? `<@${ctx.tagger}>` : "someone", t_local: berlin(ctx.message_time_utc), links: ctx.links || {},
    thread_permalink: ctx.permalink || permalink(ws, ctx.channel_id, ctx.thread_ts), reply_permalink: extra.replyTs ? permalink(ws, ctx.channel_id, extra.replyTs, ctx.thread_ts) : null,
    title: ctx.title || "", jira_project: (cfg.jira || {}).project || "", one_line: r.one_line || r.read || "",
  };
}

function trimTo(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const cut = (t, label) => t.replace(new RegExp(`\\*${label}:\\*[^\\n]*`), `*${label}:* (trimmed, see Kibana link)`);
  let t = cut(text, "Evidence"); if (t.length > max) t = cut(t, "Where");
  if (t.length > max) t = t.slice(0, max - 1) + "…";
  return { text: t, truncated: true };
}

export function render(kind, cfg, report, ctx, extra = {}) {
  const vars = buildVars(cfg, report, ctx, extra);
  const name = { thread: "thread-reply", team: "team-channel", dm: "dm", jira: "jira-description" }[kind];
  if (!name) throw new Error(`unknown kind ${kind}`);
  let text = redact(fill(loadTemplate(name), vars)).replace(/\n{3,}/g, "\n\n").trim();
  const max = kind === "thread" ? ((cfg.output || {}).maxChars || 3500) : kind === "team" ? 600 : 10000;
  const t = trimTo(text, max);
  return { kind, text: t.text, chars: t.text.length, truncated: t.truncated, max };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const kind = opt._[0];
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("render", e.message, EXIT.USAGE); }
  if (!kind || !opt.report || !opt.context) fail("render", "usage: render.mjs thread|team|dm|jira --team <team> --report report.json --context context.json [--reply-ts ts]", EXIT.USAGE);
  try { out(render(kind, cfg, readJson(opt.report), readJson(opt.context), { replyTs: opt["reply-ts"] })); }
  catch (e) { fail("render", e.message, EXIT.ERROR); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
