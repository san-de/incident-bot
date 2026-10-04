import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "./helpers.mjs";

let env;
before(() => { env = setup(); });
after(() => env.teardown());

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
