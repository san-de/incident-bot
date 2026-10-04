import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, fixture } from "./helpers.mjs";

let env, cfg, report, ctx;
before(async () => {
  env = setup();
  const { resolve } = await import("../scripts/config.mjs");
  const { buildContext } = await import("../scripts/context.mjs");
  cfg = resolve("fixture");
  report = fixture("report.json");
  const hits = fixture("hits.json");
  ctx = await buildContext(cfg, { ts: "1790000100.000100", threadTs: "1790000000.000001", channelId: "C0FIXTURE1", permalink: hits.hits[0].permalink, alertCode: "SRE0042", kibanaLinks: [], tagger: "UBOTSRE" }, hits.threads["1790000000.000001"]);
});
after(() => env.teardown());

test("render: thread reply starts with the signature, stays under maxChars, redacts", async () => {
  const { render, fill } = await import("../scripts/render.mjs");
  const t = render("thread", cfg, report, ctx);
  assert.ok(t.text.startsWith(cfg.output.signature));
  assert.ok(t.chars <= cfg.output.maxChars);
  assert.match(t.text, /\*Read:\* \*new after deploy\*/);
  assert.match(t.text, /142× in window/);
  const team = render("team", cfg, report, ctx, { replyTs: "1790000900.000900" });
  assert.ok(team.chars <= 600);
  assert.match(team.text, /triage reply/);
  assert.match(team.text, /p1790000900000900\?thread_ts=1790000000\.000001/);
  assert.equal(fill("a {{x}} {{#if y}}Y{{/if}}{{#if z}}Z{{/if}}", { x: 1, y: [], z: "k" }), "a 1 Z");
  const leaky = render("dm", cfg, Object.assign({}, report, { one_line: "token=abcdef123456 mail me at someone@auto1.com" }), ctx);
  assert.doesNotMatch(leaky.text, /abcdef123456|someone@auto1\.com/);
});

test("render: an oversized evidence list is trimmed rather than cut mid-sentence", async () => {
  const { render } = await import("../scripts/render.mjs");
  const big = Object.assign({}, report, { evidence: Array.from({ length: 80 }, (_, i) => `line ${i} ` + "x".repeat(60)) });
  const t = render("thread", cfg, big, ctx);
  assert.equal(t.truncated, true);
  assert.ok(t.chars <= cfg.output.maxChars);
  assert.match(t.text, /\*Evidence:\* \(trimmed/);
});

test("post: plan allows only the thread, the team channel and configured DMs", async () => {
  const { plan, allowedTarget } = await import("../scripts/post.mjs");
  const p = plan(cfg, report, ctx, false);
  assert.deepEqual(p.items.map(i => i.kind), ["thread", "team"]);
  assert.equal(p.items[0].reply_broadcast, false);
  assert.equal(p.items[0].thread_ts, ctx.thread_ts);
  assert.equal(allowedTarget(cfg, "C0FIXTURE1", "9999.0001", ctx).ok, false, "another thread in the source channel");
  assert.equal(allowedTarget(cfg, "C0FIXTURE1", undefined, ctx).ok, false, "top-level post in the source channel");
  assert.equal(allowedTarget(cfg, "C0TEAMCH01", undefined, ctx).ok, true);
  assert.equal(allowedTarget(cfg, "C0TEAMCH01", "1.2", ctx).ok, false, "no threads in the team channel");
  assert.equal(allowedTarget(cfg, "C0ELSEWHERE", undefined, ctx).ok, false);
});

test("jira: quarterly epic by name from the alert date", async () => {
  const { quarterOf, epicRule, buildPayload } = await import("../scripts/jira.mjs");
  assert.deepEqual(quarterOf("2026-10-04T08:00:00Z"), { q: 4, year: 2026, label: "Q4 2026" });
  assert.deepEqual(quarterOf("2026-12-31T23:59:59Z"), { q: 4, year: 2026, label: "Q4 2026" });
  assert.deepEqual(quarterOf("2027-01-01T00:00:00Z"), { q: 1, year: 2027, label: "Q1 2027" });
  assert.deepEqual(quarterOf("2026-09-30T22:00:00Z"), { q: 3, year: 2026, label: "Q3 2026" });
  const bug = epicRule(cfg, "Bug", "2026-05-04T08:00:00Z");   // Q2 2026 has no pin in the fixture
  assert.equal(bug.mode, "by-name");
  assert.equal(bug.epic_name, "BUG Q2 2026");
  assert.equal(bug.epic_key, null);
  assert.match(bug.epic_jql, /^project = FIX AND issuetype = Epic AND summary ~ "\\"BUG Q2 2026\\""/);
  assert.equal(bug.on_missing, "skip");
  assert.equal(epicRule(cfg, "Task", "2027-02-10T08:00:00Z").epic_name, "TECH Q1 2027", "byType override");
  const noPattern = JSON.parse(JSON.stringify(cfg)); delete noPattern.jira.epic;
  assert.deepEqual(epicRule(noPattern, "Bug"), { mode: "static", epic_key: "FIX-1", epic_name: null, epic_jql: null, on_missing: null });
  const p = buildPayload(cfg, report, ctx, {});
  assert.equal(p.epic.epic_name, "BUG Q3 2026", "payload uses the alert's own date (fixture alert is 21 Sep 2026), not today");
  assert.equal(p.epic_key, null, "unresolved until the search ran");
  const resolved = buildPayload(cfg, report, ctx, { epicKey: "FIX-900" });
  assert.equal(resolved.epic_key, "FIX-900");
  assert.equal(resolved.epic.mode, "by-name:resolved");
});

test("jira: rule table, dedupe JQL, payload with labels and idempotency key", async () => {
  const { classify, dedupeJql, buildPayload, proposeLabels } = await import("../scripts/jira.mjs");
  assert.deepEqual(classify(report, cfg), { classification: "new after deploy", issue_type: "Bug", decided_by: "rule", should_create: true, reason: 'classification "new after deploy" maps to Bug' });
  assert.equal(classify(Object.assign({}, report, { classification: "steady noise" }), cfg).should_create, false);
  assert.equal(classify(Object.assign({}, report, { classification: "unknown" }), cfg).decided_by, "model-needed");
  const j = dedupeJql(cfg, report, ctx);
  assert.match(j.jql, /^project = FIX AND created >= -30d/);
  assert.match(j.jql, /2b06a360/);
  assert.deepEqual(proposeLabels(cfg, ctx, "extra, with space"), ["auto-triage", "service:pricing-service", "extra"]);
  const p = buildPayload(cfg, report, ctx, { labels: "pricing" });
  assert.equal(p.project_key, "FIX");
  assert.equal(p.issue_type, "Bug");
  assert.equal(p.epic.epic_name, "BUG Q3 2026");
  assert.equal(p.idempotency_key, "incident-bot:fixture:1790000000.000001");
  assert.match(p.summary, /^\[SRE0042\] pricing-service: java\.lang\.NullPointerException/);
  assert.match(p.description_text, /h3\. Alert/);
  assert.throws(() => buildPayload(cfg, Object.assign({}, report, { classification: "unknown" }), ctx), /undecided/);
});

test("jira: create-epic rule produces the epic payload for an unpinned quarter and never for a pinned one", async () => {
  const { epicRule } = await import("../scripts/jira.mjs");
  const c = JSON.parse(JSON.stringify(cfg)); c.jira.epic.onMissing = "create-epic";
  const r = epicRule(c, "Bug", "2027-02-10T08:00:00Z");
  assert.equal(r.on_missing, "create-epic");
  assert.deepEqual(r.epic_create, { project_key: "FIX", issue_type: "Epic", summary: "BUG Q1 2027",
    description_text: r.epic_create.description_text, labels: ["auto-triage", "incident-bot-epic"], idempotency_key: "incident-bot:fixture:epic:Q1-2027" });
  assert.match(r.epic_create.description_text, /Quarterly epic for Q1 2027, created by incident-bot/);
  assert.equal(epicRule(c, "Bug", "2026-11-01T08:00:00Z").epic_create, undefined, "pinned quarter: nothing to create");
  const s = JSON.parse(JSON.stringify(cfg)); s.jira.epic.onMissing = "skip";
  assert.equal(epicRule(s, "Bug", "2027-02-10T08:00:00Z").epic_create, null);
});

test("jira: a pinned quarter wins over the name search; local dedupe finds tickets already filed", async () => {
  const { epicRule, localDuplicates } = await import("../scripts/jira.mjs");
  const pinned = epicRule(cfg, "Bug", "2026-11-20T08:00:00Z");
  assert.equal(pinned.mode, "pinned");
  assert.equal(pinned.epic_key, "FIX-500");
  assert.equal(pinned.epic_jql, null);
  assert.equal(epicRule(cfg, "Bug", "2027-01-05T08:00:00Z").mode, "by-name", "no pin for Q1 2027 → search by name");

  const ledger = { processed: {
    "1790000100.000100": { status: "posted", threadTs: "1790000000.000001", ticket: "FIX-41", processedAt: new Date().toISOString() },
    "1780000100.000100": { status: "posted", threadTs: "1780000000.000001", ticket: "FIX-7", errorId: "2b06a360", processedAt: new Date(Date.now() - 5 * 864e5).toISOString() },
    "1770000100.000100": { status: "posted", threadTs: "1770000000.000001", ticket: "FIX-3", signature: "java.lang.NullPointerException: other", service: "pricing-service", processedAt: new Date(Date.now() - 10 * 864e5).toISOString() },
    "1760000100.000100": { status: "posted", threadTs: "1760000000.000001", ticket: "FIX-1", errorId: "2b06a360", processedAt: new Date(Date.now() - 40 * 864e5).toISOString() },
    "1750000100.000100": { status: "posted", threadTs: "1750000000.000001", processedAt: new Date().toISOString() },
  } };
  const dups = localDuplicates(ledger, ctx, report, 30);
  assert.deepEqual(dups.map(d => [d.ticket, d.match.join("+")]).sort(), [["FIX-3", "signature"], ["FIX-41", "thread"], ["FIX-7", "error.id"]]);
  assert.equal(localDuplicates(ledger, Object.assign({}, ctx, { thread_ts: "x", error_id: "zzz" }), Object.assign({}, report, { kibana: { signature: "Other" } }), 30).length, 0);
});
