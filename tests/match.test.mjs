import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, fixture } from "./helpers.mjs";

let env;
before(() => { env = setup(); });
after(() => env.teardown());

test("match applies the rules in order and caps at maxPerRun", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { matchCandidates } = await import("../scripts/match.mjs");
  const cfg = resolve("fixture");
  const hits = fixture("hits.json");
  const now = 1790001000;   // ~7 minutes after the newest hit; the 1789000000 hit is > 48 h old
  const r = matchCandidates(cfg, { processed: {}, repliedThreads: {} }, hits, now);
  const reasons = Object.fromEntries(r.skipped.map(s => [s.ts, s.reason]));
  assert.equal(r.candidates.length, 2, "maxPerRun 2");
  assert.deepEqual(r.candidates.map(c => c.alertCode), ["SRE0042", "SRE0043"]);
  assert.equal(r.candidates[0].threadTs, "1790000000.000001");
  assert.deepEqual(r.candidates[0].kibanaLinks.length, 1);
  assert.match(reasons["1790000200.000200"], /non-alert mention/);
  assert.match(reasons["1790000300.000300"], /ignored user group/);
  assert.match(reasons["1790000400.000400"], /SRE0099 excluded/);
  assert.match(reasons["1790000600.000600"], /deferred/);
  assert.match(reasons["1789000000.000000"], /stale/);
});

test("match accepts a QA-style alert: tag in the parent message, no SRE code, a Kibana goto link", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { matchCandidates } = await import("../scripts/match.mjs");
  const cfg = resolve("fixture");
  const hits = { hits: [{ ts: "1790000700.000700", threadTs: "1790000700.000700", channelId: "C0FIXTURE1", user: "UALERTBOT",
    text: "'REM - ERROR rate - QA'\n\n<!subteam^S0FIXTURE01|fixture-be>\n\nDetails:\n- Timestamp: 2026-10-05T10:47:04.052Z\n- Hits: 1\nService name: remarketing-car\n<https://kibana.qa.services.auto1.team/goto/41e8286320510f7a3a82a425b842ad67|Kibana Discover Link>" }], threads: {} };
  const r = matchCandidates(cfg, { processed: {}, repliedThreads: {} }, hits, 1790001000);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].alertCode, null);
  assert.match(r.candidates[0].kibanaLinks[0], /goto\/41e8/);
});

test("match groups repeats of the same alert+service in a run and suppresses ones analysed within the repeat window", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { matchCandidates, alertKeyOf } = await import("../scripts/match.mjs");
  const cfg = resolve("fixture");
  const mk = (ts, svc) => ({ ts, threadTs: ts, channelId: "C0FIXTURE1", user: "UALERTBOT", text: `'REM - ERROR rate - QA'\n\n<!subteam^S0FIXTURE01|fixture-be>\n\nDetails:\n- Hits: 1\nService name: ${svc}\n<https://kibana.qa.services.auto1.team/goto/abc123|Kibana Discover Link>` });
  const hits = { hits: [mk("1790000710.000001", "remarketing-feedback"), mk("1790000720.000001", "zrt-admin-dashboard"), mk("1790000730.000001", "remarketing-feedback"), mk("1790000740.000001", "remarketing-feedback"), mk("1790000750.000001", "remarketing-changelog")], threads: {} };
  assert.equal(alertKeyOf(hits.hits[0].text), "rem - error rate - qa::remarketing-feedback");
  assert.equal(alertKeyOf("<!subteam^S1|x>, please take a look: *[SRE0042]: Error rate above threshold | pricing-service*"), "sre0042::pricing-service");
  const now = 1790001000;
  const r = matchCandidates(cfg, { processed: {}, repliedThreads: {} }, hits, now);
  assert.deepEqual(r.candidates.map(c => c.alertKey.split("::")[1]), ["remarketing-feedback", "zrt-admin-dashboard"], "maxPerRun 2; feedback repeats grouped, changelog deferred");
  assert.deepEqual(r.candidates[0].repeats, ["1790000730.000001", "1790000740.000001"]);
  assert.equal(r.skipped.filter(s => /grouped with/.test(s.reason)).length, 2);
  assert.equal(r.deferredOldestTs, "1790000750.000001");
  assert.match(r.watermarkAdvanceHint, /1790000750\.000000/);
  // next run: feedback was posted 1 h ago with its alert key → suppressed; changelog is new
  const ledger = { processed: { "1790000710.000001": { status: "posted", alertKey: "rem - error rate - qa::remarketing-feedback", processedAt: new Date((now - 3600) * 1000).toISOString() } }, repliedThreads: {} };
  const r2 = matchCandidates(cfg, ledger, { hits: [mk("1790000900.000001", "remarketing-feedback"), mk("1790000910.000001", "remarketing-changelog")], threads: {} }, now);
  assert.deepEqual(r2.candidates.map(c => c.alertKey.split("::")[1]), ["remarketing-changelog"]);
  assert.match(r2.skipped[0].reason, /same alert\+service analysed .*within 24 h/);
  // window off → no suppression, no grouping
  const off = JSON.parse(JSON.stringify(cfg)); off.skip.repeatWindowHours = 0;
  assert.equal(matchCandidates(off, ledger, { hits: [mk("1790000900.000001", "remarketing-feedback"), mk("1790000905.000001", "remarketing-feedback")], threads: {} }, now).candidates.length, 2);
});

test("match skips threads the ledger or the signature already covers", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { matchCandidates } = await import("../scripts/match.mjs");
  const cfg = resolve("fixture");
  const hits = fixture("hits.json");
  const ledger = { processed: { "1790000500.000500": { status: "posted" } }, repliedThreads: { "1790000000.000001": "1790000900.000900" } };
  const r = matchCandidates(cfg, ledger, hits, 1790001000);
  const reasons = Object.fromEntries(r.skipped.map(s => [s.ts, s.reason]));
  assert.match(reasons["1790000100.000100"], /thread already replied \(ledger\)/);
  assert.match(reasons["1790000500.000500"], /already handled \(posted\)/);
  assert.deepEqual(r.candidates.map(c => c.alertCode), ["SRE0044"]);

  const sigHits = JSON.parse(JSON.stringify(hits));
  sigHits.threads["1790000000.000001"].push({ ts: "1790000950.000950", user: "UBOT", text: cfg.output.signature + "\n*What happens:* …" });
  const r2 = matchCandidates(cfg, { processed: {}, repliedThreads: {} }, sigHits, 1790001000);
  assert.match(Object.fromEntries(r2.skipped.map(s => [s.ts, s.reason]))["1790000100.000100"], /signature found/);
});
