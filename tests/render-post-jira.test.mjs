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
  assert.equal(p.epic_key, "FIX-1");
  assert.equal(p.idempotency_key, "incident-bot:fixture:1790000000.000001");
  assert.match(p.summary, /^\[SRE0042\] pricing-service: java\.lang\.NullPointerException/);
  assert.match(p.description_text, /h3\. Alert/);
  assert.throws(() => buildPayload(cfg, Object.assign({}, report, { classification: "unknown" }), ctx), /undecided/);
});
