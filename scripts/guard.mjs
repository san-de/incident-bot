#!/usr/bin/env node
// Run this before anything else in a session. It answers one question: can this run start at all?
// Exit 0 → go. Exit 6 → stop the run and say why; the platform-hosted guard skill turns that into a Slack message.
//
//   node scripts/guard.mjs --team remex [--min-node 20]
//
// Checks: node version · VERSION file · team config exists and validates · state dir writable · ledger initialisable.
// Prints JSON { ok, version, team, checks:[{name, ok, detail}] }. Never prints a secret.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, EXIT } from "./lib/cli.mjs";
import { REPO_ROOT, listTeams, validate, resolve, pickTeam } from "./config.mjs";
import { init } from "./ledger.mjs";

const opt = parseArgs(process.argv.slice(2));
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const major = Number(process.versions.node.split(".")[0]);
add("node", major >= Number(opt["min-node"] || 20), `node ${process.versions.node}`);

const versionFile = path.join(REPO_ROOT, "VERSION");
const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
add("version", !!version, version ? `incident-bot ${version}` : "VERSION file missing (is the clone complete?)");

let team = null, cfg = null;
try { team = pickTeam(opt.team); } catch (e) { add("team", false, e.message); }
if (team) {
  const v = validate(team);
  add("config", v.ok, v.ok ? `${v.file}` : v.errors.join("; "));
  if (v.ok) {
    cfg = resolve(team);
    try { fs.mkdirSync(cfg.teamStateDir, { recursive: true }); fs.accessSync(cfg.teamStateDir, fs.constants.W_OK); add("state-dir", true, cfg.teamStateDir); }
    catch (e) { add("state-dir", false, `${cfg.teamStateDir}: ${e.code || e.message}`); }
    try { const l = init(cfg); add("ledger", true, `${l.path} (watermark ${l.watermarkTs}${l.created ? ", created" : ""})`); }
    catch (e) { add("ledger", false, e.message); }
  }
}
add("teams-dir", listTeams().length > 0, `${listTeams().length} team config(s)`);

const ok = checks.every(c => c.ok);
out({ ok, version, team, mode: cfg ? cfg.mode : null, checks, stop_reason: ok ? null : checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join(" | ") });
process.exit(ok ? EXIT.OK : EXIT.GUARD);
