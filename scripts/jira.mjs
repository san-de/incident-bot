#!/usr/bin/env node
// Chunk 8: classify, dedupe query, payload, and the create call. Classification is a rule table; the model is only
// consulted for "unknown" (the skill does that, not this script). Creation goes through the path the team config names:
//   createVia: "webhook" → POST the payload to an Agent1 automation webhook (HTTP step holds the Jira token in Secrets)
//   createVia: "mcp"     → print the payload; the skill calls an Atlassian MCP create tool if the session has one
//   createVia: "none"    → classify and prepare only
//
//   node scripts/jira.mjs classify --team remex --report report.json
//   node scripts/jira.mjs jql      --team remex --report report.json --context context.json
//   node scripts/jira.mjs payload  --team remex --report report.json --context context.json [--labels a,b] [--type Bug|Task]
//   node scripts/jira.mjs create   --team remex --payload payload.json        # webhook path; URL + secret from env/file, never printed
//
// Webhook credentials: INCIDENT_BOT_JIRA_WEBHOOK_URL and INCIDENT_BOT_JIRA_WEBHOOK_SECRET in the environment, or a JSON
// file at INCIDENT_BOT_JIRA_WEBHOOK_FILE { "url": …, "secret": … }. Exit 2 when missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { readJson } from "./lib/io.mjs";
import { resolve, pickTeam } from "./config.mjs";
import { render } from "./render.mjs";
import { redact } from "./lib/redact.mjs";

export const TYPE_RULES = {
  "new after deploy": "Bug", "pre-existing, grew": "Bug", "upstream dependency": "Bug",
  "infra": "Task", "pre-existing, flat": "Task", "steady noise": "Task", "noise": "Task", "expected business validation": "Task",
};

export function classify(report, cfg) {
  const c = String(report.classification || "unknown");
  const type = TYPE_RULES[c] || null;
  const createFor = ((cfg.jira || {}).createFor) || [];
  return { classification: c, issue_type: type, decided_by: type ? "rule" : "model-needed",
    should_create: !!type && createFor.includes(c), reason: type ? `classification "${c}" maps to ${type}` : `classification "${c}" has no rule; ask the model, then a person confirms` };
}

export function dedupeJql(cfg, report, ctx, days = 30) {
  const proj = (cfg.jira || {}).project;
  const terms = [];
  if (ctx.error_id) terms.push(`text ~ "${ctx.error_id}"`);
  const sig = ((report.kibana || {}).signature || ctx.signature_hint || "").split(":")[0].trim();
  if (sig && sig.length > 6) terms.push(`text ~ "\\"${sig.replace(/"/g, "")}\\""`);
  if (ctx.service_name) terms.push(`(text ~ "${ctx.service_name}" AND created >= -${days}d)`);
  const scope = `project = ${proj} AND created >= -${days}d AND statusCategory != Done`;
  return { jql: terms.length ? `${scope} AND (${terms.join(" OR ")}) ORDER BY created DESC` : null, terms, days };
}

export function proposeLabels(cfg, ctx, extra) {
  const base = ((cfg.jira || {}).labels) || [];
  const svc = ctx.service_name ? [`service:${ctx.service_name}`] : [];
  const add = extra ? String(extra).split(",").map(s => s.trim()).filter(Boolean) : [];
  return [...new Set([...base, ...svc, ...add])].filter(l => /^[^\s]+$/.test(l));
}

export function buildPayload(cfg, report, ctx, opts = {}) {
  const j = cfg.jira || {};
  const cls = classify(report, cfg);
  const type = opts.type || cls.issue_type;
  if (!type) throw new Error("issue type undecided; pass --type Bug|Task after the model/person decided");
  const desc = render("jira", cfg, report, ctx).text;
  const summary = `[${ctx.alert_code || "alert"}] ${ctx.service_name || "service"}: ${(report.kibana || {}).signature || report.one_line || report.read || "triage"}`.slice(0, 200);
  const payload = {
    project_key: j.project, issue_type: type, summary, labels: proposeLabels(cfg, ctx, opts.labels),
    epic_key: (j.epics || {})[type === "Bug" ? "bug" : "tech-improvement"] || null, priority: opts.priority || null,
    description_fields: { service: ctx.service_name, signature: (report.kibana || {}).signature || ctx.signature_hint || null, window_utc: `${ctx.window_utc.from}..${ctx.window_utc.to}`,
      count: (report.kibana || {}).count ?? null, kibana_link: (ctx.links || {}).kibana || null, slack_permalink: ctx.permalink || null,
      suspects: ((report.git || {}).suspects || []).map(s => `${s.ref} ${s.title}`), next_action: report.next_action || "" },
    description_text: desc, idempotency_key: `incident-bot:${cfg.team}:${ctx.thread_ts}`,
    source: { team: cfg.team, thread_ts: ctx.thread_ts, channel_id: ctx.channel_id, classification: report.classification, decided_by: opts.type ? "override" : cls.decided_by },
  };
  return payload;
}

function webhookCreds() {
  if (process.env.INCIDENT_BOT_JIRA_WEBHOOK_URL) return { url: process.env.INCIDENT_BOT_JIRA_WEBHOOK_URL, secret: process.env.INCIDENT_BOT_JIRA_WEBHOOK_SECRET || "", source: "env" };
  const f = process.env.INCIDENT_BOT_JIRA_WEBHOOK_FILE;
  if (f && fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); return { url: j.url, secret: j.secret || "", source: "file" }; }
  return null;
}

async function createViaWebhook(payload) {
  const c = webhookCreds();
  if (!c || !c.url) return { error: "no webhook configured (INCIDENT_BOT_JIRA_WEBHOOK_URL or INCIDENT_BOT_JIRA_WEBHOOK_FILE)", code: EXIT.USAGE };
  let res;
  try {
    res = await fetch(c.url, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": c.secret, "Idempotency-Key": payload.idempotency_key },
      body: JSON.stringify({ event: "incident_bot.create_issue", payload }) });
  } catch (e) { return { error: redact(e.message), code: 3 }; }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} (webhook secret)`, code: EXIT.AUTH };
  if (res.status >= 300) return { error: `HTTP ${res.status} ${redact(text.slice(0, 200))}`, code: EXIT.ERROR };
  let body; try { body = JSON.parse(text); } catch { body = { raw: redact(text.slice(0, 300)) }; }
  return { accepted: true, via: c.source, response: body };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0];
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("jira", e.message, EXIT.USAGE); }
  try {
    if (cmd === "classify") return out(classify(readJson(opt.report), cfg));
    if (cmd === "jql") return out(dedupeJql(cfg, readJson(opt.report), readJson(opt.context), Number(opt.days || 30)));
    if (cmd === "payload") return out(buildPayload(cfg, readJson(opt.report), readJson(opt.context), { labels: opt.labels, type: opt.type, priority: opt.priority }));
    if (cmd === "create") {
      const via = (cfg.jira || {}).createVia || "none";
      const payload = readJson(opt.payload);
      if (via === "webhook") { const r = await createViaWebhook(payload); if (r.error) fail("jira", r.error, r.code); return out(r); }
      if (via === "mcp") return out({ accepted: false, via: "mcp", instruction: "call the Atlassian create-issue tool with this payload; then post.mjs mark --ticket <KEY>", payload });
      return out({ accepted: false, via: "none", instruction: "jira.createVia is none; nothing created", payload });
    }
    fail("jira", "usage: jira.mjs classify|jql|payload|create …", EXIT.USAGE);
  } catch (e) { fail("jira", e.message, EXIT.ERROR); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
