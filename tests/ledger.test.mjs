import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "./helpers.mjs";

let env;
before(() => { env = setup(); });
after(() => env.teardown());

test("ledger: export/import restores an empty volume and merges into an existing one", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { init, mark, importLedger, mergeLedgers, load } = await import("../scripts/ledger.mjs");
  const cfg = resolve("fixture");
  init(cfg);
  mark(cfg, "1790000100.000100", { status: "posted", threadTs: "1790000000.000001", threadReplyTs: "1790000900.000900", alertKey: "a::svc" });
  const backup = JSON.parse(JSON.stringify(load(cfg)));
  // simulate a recreated task: empty volume
  fs.rmSync(cfg.ledgerPath);
  init(cfg);
  assert.equal(Object.keys(load(cfg).processed).length, 0);
  const r = importLedger(cfg, backup);
  assert.equal(r.mode, "merged");   // init created a fresh ledger first, so this is a merge
  assert.equal(load(cfg).processed["1790000100.000100"].alertKey, "a::svc");
  assert.equal(load(cfg).repliedThreads["1790000000.000001"], "1790000900.000900");
  // merge rules: newer processedAt wins, later watermark wins, runs deduped by at
  const a = { version: 2, team: "fixture", watermarkTs: "100.000000", processed: { x: { status: "dry-run", processedAt: "2026-10-01T00:00:00Z" } }, repliedThreads: {}, runs: [{ at: "2026-10-01T00:00:00Z" }] };
  const b = { version: 2, team: "fixture", watermarkTs: "200.000000", processed: { x: { status: "posted", processedAt: "2026-10-02T00:00:00Z" }, y: { status: "skipped", processedAt: "2026-10-02T01:00:00Z" } }, repliedThreads: { t: "r" }, runs: [{ at: "2026-10-01T00:00:00Z" }, { at: "2026-10-02T00:00:00Z" }] };
  const m = mergeLedgers(a, b);
  assert.equal(m.processed.x.status, "posted"); assert.equal(m.watermarkTs, "200.000000"); assert.equal(m.runs.length, 2); assert.equal(m.repliedThreads.t, "r");
  assert.throws(() => importLedger(cfg, { version: 2, team: "other", processed: {} }), /import refused/);
  fs.rmSync(cfg.ledgerPath);
});

test("ledger: init, mark, advance forwards only, run-note", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { init, mark, advance, runNote, load } = await import("../scripts/ledger.mjs");
  const cfg = resolve("fixture");
  const i = init(cfg);
  assert.equal(i.created, true);
  assert.ok(fs.existsSync(cfg.ledgerPath));
  assert.equal(init(cfg).created, false, "idempotent");

  const m = mark(cfg, "1790000100.000100", { status: "posted", threadTs: "1790000000.000001", threadReplyTs: "1790000900.000900", classification: "new after deploy" });
  assert.equal(m.repliedThread, true);
  assert.equal(load(cfg).repliedThreads["1790000000.000001"], "1790000900.000900");

  const w0 = load(cfg).watermarkTs;
  assert.equal(advance(cfg, (Number(w0) - 100).toFixed(6)).moved, false, "never backwards");
  assert.equal(advance(cfg, (Number(w0) + 100).toFixed(6)).moved, true);

  const n = runNote(cfg, { candidates: 1, posted: 1, skipped: 0, failed: 0, durationSec: 12 });
  assert.equal(n.runs, 1);
  assert.ok(n.lastSuccessfulRunAt);
  const n2 = runNote(cfg, { candidates: 1, posted: 0, skipped: 0, failed: 1 });
  assert.equal(n2.runs, 2);
  assert.equal(n2.lastSuccessfulRunAt, n.lastSuccessfulRunAt, "a failed run does not move lastSuccessfulRunAt");
});
