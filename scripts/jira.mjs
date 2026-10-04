#!/usr/bin/env node
// Chunk 8: classify, dedupe query, payload, and the create call. Classification is a rule table; the model is only
// consulted for "unknown" (the skill does that, not this script). Creation goes through the path the team config names:
//   createVia: "webhook" → POST the payload to an Agent1 automation webhook (HTTP step holds the Jira token in Secrets)
//   createVia: "mcp"     → print the payload; the skill calls an Atlassian MCP create tool if the session has one
//   createVia: "none"    → classify and prepare only
//
//   node scripts/jira.mjs classify --team remex --report report.json
//   node scripts/jira.mjs local    --team remex --context context.json [--report report.json] [--days 30]   # tickets this bot already filed (ledger)
//   node scripts/jira.mjs jql      --team remex --report report.json --context context.json
//   node scripts/jira.mjs epic     --team remex [--type Bug|Task] [--context context.json | --at 2026-10-04T08:00:00Z]   # quarterly epic name + JQL
//   node scripts/jira.mjs payload  --team remex --report report.json --context context.json [--labels a,b] [--type Bug|Task] [--epic-key REMEX-123]
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

/**
 * Quarterly epic rule. The team keeps one epic per quarter, named by a pattern such as "BUG Q{Q} {YYYY}" (→ "BUG Q4 2026").
 * The epic is resolved by name in the project at create time, from the alert's date (not today's), so a late triage of a
 * 30 September alert still lands in Q3. Config:
 *   jira.epic: { "namePattern": "BUG Q{Q} {YYYY}", "byType": { "Task": "TECH Q{Q} {YYYY}" }, "onMissing": "skip" | "create-without-epic" }
 * jira.epics (static keys per type) stays as a fallback when no pattern is configured.
 */
export function quarterOf(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { q, year: d.getUTCFullYear(), label: `Q${q} ${d.getUTCFullYear()}` };
}

export function epicRule(cfg, type, atIso) {
  const j = cfg.jira || {};
  const e = j.epic || {};
  const pattern = (e.byType || {})[type] || e.namePattern || null;
  const staticKey = (j.epics_legacy || j.epics || {})[type === "Bug" ? "bug" : "tech-improvement"] || null;
  if (!pattern) return { mode: staticKey ? "static" : "none", epic_key: staticKey, epic_name: null, epic_jql: null, on_missing: null };
  const { q, year, label } = quarterOf(atIso);
  const name = pattern.replace(/\{Q\}/g, String(q)).replace(/\{YYYY\}/g, String(year)).replace(/\{YY\}/g, String(year).slice(-2));
  // A pinned key for this quarter wins over the name search (jira.epic.pins: { "Q4 2026": "REMEX-3028" }).
  const pinned = (e.pins || {})[label] || null;
  if (pinned) return { mode: "pinned", quarter: label, epic_key: pinned, epic_name: name, epic_jql: null, on_missing: null, note: `epic pinned for ${label}; no search needed` };
  const onMissing = e.onMissing || "skip";
  const notes = {
    "skip": "no match → do not create the ticket; report that the epic is missing",
    "create-without-epic": "no match → create the ticket without an epic and record the gap",
    "create-epic": "no match → create the epic from epic_create (search once more first), then file the ticket under it",
  };
  return {
    quarter: label,
    mode: "by-name", epic_key: null, epic_name: name,
    epic_jql: `project = ${j.project} AND issuetype = Epic AND summary ~ "\\"${name.replace(/"/g, "")}\\"" ORDER BY created DESC`,
    on_missing: onMissing,
    epic_create: onMissing === "create-epic" ? {
      project_key: j.project, issue_type: "Epic", summary: name,
      description_text: `Quarterly epic for ${label}, created by incident-bot (team ${cfg.team}) because no epic named "${name}" existed when the first ticket of the quarter was filed. Tickets from alert triage in ${label} are filed under this epic.`,
      labels: [...new Set([...(j.labels || []), "incident-bot-epic"])].filter(l => /^[^\s]+$/.test(l)),
      idempotency_key: `incident-bot:${cfg.team}:epic:${label.replace(" ", "-")}`,
    } : null,
    note: `resolve the epic key by running epic_jql; exact summary match wins; ${notes[onMissing]}`,
  };
}

/**
 * Local dedupe: tickets this bot already filed, from the ledger. Matches the same Slack thread, the same error.id, or the
 * same exception signature (first token before ":") within `days`. Runs before any Jira search and needs no credential.
 */
export function localDuplicates(ledger, ctx, report, days = 30) {
  const since = Date.now() - days * 864e5;
  const sig = String((report && report.kibana && report.kibana.signature) || ctx.signature_hint || "").split(":")[0].trim().toLowerCase();
  const dups = [];
  for (const [ts, e] of Object.entries((ledger && ledger.processed) || {})) {
    if (!e.ticket) continue;
    if (e.processedAt && Date.parse(e.processedAt) < since) continue;
    const matches = [];
    if (e.threadTs && e.threadTs === ctx.thread_ts) matches.push("thread");
    if (ctx.error_id && e.errorId && e.errorId === ctx.error_id) matches.push("error.id");
    if (sig && e.signature && String(e.signature).split(":")[0].trim().toLowerCase() === sig && (!e.service || !ctx.service_name || e.service === ctx.service_name)) matches.push("signature");
    if (matches.length) dups.push({ ticket: e.ticket, ts, threadTs: e.threadTs || null, match: matches, processedAt: e.processedAt || null });
  }
  return dups;
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
  const epic = epicRule(cfg, type, ctx.message_time_utc || (ctx.window_utc || {}).to);
  if (opts.epicKey) { epic.epic_key = opts.epicKey; epic.mode = epic.mode === "by-name" ? "by-name:resolved" : "override"; }
  const payload = {
    project_key: j.project, issue_type: type, summary, labels: proposeLabels(cfg, ctx, opts.labels),
    epic, epic_key: epic.epic_key, priority: opts.priority || null,
    description_fields: { service: ctx.service_name, signature: (report.kibana || {}).signature || ctx.signature_hint || null, window_utc: `${ctx.window_utc.from}..${ctx.window_utc.to}`,
      count: (report.kibana || {}).count ?? null, kibana_link: (ctx.links || {}).kibana || null, slack_permalink: ctx.permalink || null,
      suspects: ((report.git || {}).suspects || []).map(s => `${s.ref} ${s.title}`), next_action: report.next_action || "" },
    description_text: desc, idempotency_key: `incident-bot:${cfg.team}:${ctx.thread_ts}`,
    dedupe_jql: dedupeJql(cfg, report, ctx).jql, error_id: ctx.error_id || null,
    source: { team: cfg.team, thread_ts: ctx.thread_ts, channel_id: ctx.channel_id, classification: report.classification, decided_by: opts.type ? "override" : cls.decided_by },
  };
  return payload;
}

/** Arguments for the Agent1 Atlassian MCP `create_jira_issue` tool. Description is Markdown (the tool converts to ADF). */
export function mcpCreateCall(payload) {
  const additional = {};
  if (payload.epic_key) additional.parent = { key: payload.epic_key };   // Jira Cloud epic link; if the project uses the legacy Epic Link field, the skill swaps this for {"customfield_…": key} after get_jira_issue_type_fields
  return {
    tool: "create_jira_issue",
    args: { projectKey: payload.project_key, issueType: payload.issue_type, summary: payload.summary,
      description: payload.description_text + `\n\n_idempotency: ${payload.idempotency_key}_`, labels: payload.labels,
      ...(payload.priority ? { priority: payload.priority } : {}), additionalFields: additional },
    before: ["search_jira_issues with payload.dedupe_jql and with text ~ idempotency_key: any hit → reuse, do not create"],
    after: ["post.mjs mark --ticket <KEY> --error-id <error_id> --service <service> --signature <signature>", "add the key to the Slack thread reply"],
  };
}

/** Arguments to create the quarter epic itself when jira.epic.onMissing is create-epic and the search found nothing. */
export function mcpEpicCall(payload) {
  const ec = payload.epic.epic_create;
  return {
    tool: "create_jira_issue",
    args: { projectKey: ec.project_key, issueType: "Epic", summary: ec.summary, description: ec.description_text + `\n\n_idempotency: ${ec.idempotency_key}_`, labels: ec.labels, additionalFields: {} },
    before: ["search_jira_issues with payload.epic.epic_jql once more; a hit → use its key instead"],
    after: ["use the returned key as the ticket's parent", "say in the thread reply: created epic <KEY> \"<summary>\""],
  };
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
    if (cmd === "local") {
      if (!opt.context) fail("jira", "local needs --context", EXIT.USAGE);
      const { readJsonIf } = await import("./lib/io.mjs");
      const ledger = readJsonIf(cfg.ledgerPath, { processed: {} });
      const dups = localDuplicates(ledger, readJson(opt.context), opt.report ? readJson(opt.report) : null, Number(opt.days || 30));
      return out({ duplicates: dups, create_allowed: dups.length === 0, source: cfg.ledgerPath });
    }
    if (cmd === "epic") { const ctx = opt.context ? readJson(opt.context) : {}; return out(epicRule(cfg, opt.type || "Bug", opt.at || ctx.message_time_utc || (ctx.window_utc || {}).to)); }
    if (cmd === "payload") return out(buildPayload(cfg, readJson(opt.report), readJson(opt.context), { labels: opt.labels, type: opt.type, priority: opt.priority, epicKey: opt["epic-key"] }));
    if (cmd === "create") {
      const via = (cfg.jira || {}).createVia || "none";
      const payload = readJson(opt.payload);
      if (via === "webhook") { const r = await createViaWebhook(payload); if (r.error) fail("jira", r.error, r.code); return out(r); }
      if (via === "mcp") return out({ accepted: false, via: "mcp", instruction: "call the Agent1 Atlassian MCP tool (name ends in create_jira_issue) with mcp_call.args; on success post.mjs mark --ticket <KEY> --error-id … --service … --signature …",
        mcp_call: mcpCreateCall(payload), epic_call: payload.epic && payload.epic.epic_create && !payload.epic_key ? mcpEpicCall(payload) : null, payload });
      return out({ accepted: false, via: "none", instruction: "jira.createVia is none; nothing created", payload });
    }
    fail("jira", "usage: jira.mjs classify|local|jql|epic|payload|create …", EXIT.USAGE);
  } catch (e) { fail("jira", e.message, EXIT.ERROR); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
