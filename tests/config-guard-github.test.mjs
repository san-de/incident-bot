import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { setup, ROOT } from "./helpers.mjs";

let env;
before(() => { env = setup(); });
after(() => env.teardown());

test("config validate passes the fixture and every checked-in team", async () => {
  const { validate, listTeams } = await import("../scripts/config.mjs");
  for (const t of listTeams().filter(x => !x.example)) {
    const r = validate(t.team);
    assert.equal(r.ok, true, `${t.team}: ${r.errors.join("; ")}`);
  }
});

test("config validate rejects a team channel that is also a source channel", async () => {
  const fs = await import("node:fs");
  const { validate } = await import("../scripts/config.mjs");
  const file = path.join(ROOT, "config", "teams", "fixture.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.output.teamChannelId = j.slack.channels[0].id;
  fs.writeFileSync(file, JSON.stringify(j));
  const r = validate("fixture");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /self-triggering/.test(e)));
  j.output.teamChannelId = "C0TEAMCH01";
  fs.writeFileSync(file, JSON.stringify(j));
});

test("guard exits 0 for the fixture team and 6 for an unknown team", () => {
  const ok = spawnSync("node", [path.join(ROOT, "scripts", "guard.mjs"), "--team", "fixture"], { encoding: "utf8", env: process.env });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.ok, true);
  assert.ok(j.checks.find(c => c.name === "ledger").ok);
  const bad = spawnSync("node", [path.join(ROOT, "scripts", "guard.mjs"), "--team", "nope"], { encoding: "utf8", env: process.env });
  assert.equal(bad.status, 6);
  assert.match(JSON.parse(bad.stdout).stop_reason, /no team config/);
});

test("github: frame parsing and log parsing; recent + frame on this repo's own history", async () => {
  const { parseFrame, recentFromLog } = await import("../scripts/github.mjs");
  const f = parseFrame("com.auto1.pricing.PriceService$Inner.compute(PriceService.java:142)");
  assert.deepEqual(f, { className: "com.auto1.pricing.PriceService", method: "compute", file: "PriceService.java", line: 142, pathHint: "com/auto1/pricing/PriceService.java" });
  const log = "\x1eabc1234\x1f2026-10-04T05:00:00+00:00\x1fJane\x1fHandle optional base price (#812)\nsrc/A.java\nsrc/B.java\n\x1edef5678\x1f2026-10-03T05:00:00+00:00\x1fJoe\x1fchore\n";
  const c = recentFromLog(log);
  assert.equal(c.length, 2);
  assert.equal(c[0].pr, 812);
  assert.deepEqual(c[0].paths, ["src/A.java", "src/B.java"]);
  assert.equal(c[1].pr, null);
  // live run against this repo (needs at least one commit); skipped on a fresh clone with no history
  let hasHistory = true;
  try { execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { stdio: "ignore" }); } catch { hasHistory = false; }
  if (hasHistory) {
    const r = spawnSync("node", [path.join(ROOT, "scripts", "github.mjs"), "recent", "--repo-dir", ROOT, "--anchor", new Date().toISOString(), "--lookback-hours", "87600"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Array.isArray(JSON.parse(r.stdout).commits));
  }
});

test("redact removes key shapes, emails and VIN middles", async () => {
  const { redact } = await import("../scripts/lib/redact.mjs");
  const s = redact("xoxb-123456789012-abcdefghijkl ghp_abcdefghijklmnopqrstuvwxyz1234 mail a.b@auto1.com vin WAUZZZ8V5KA123456 Bearer abcdefghijklmnopqrstu password=hunter22");
  assert.doesNotMatch(s, /xoxb-1234|ghp_abc|a\.b@auto1|KA123456|abcdefghijklmnopqrstu|hunter22/);
  assert.match(s, /<slack-token>.*<github-token>.*<email>.*WAUZZ…456/);
});
