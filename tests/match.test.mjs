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
