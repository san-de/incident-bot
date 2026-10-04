// Test helpers: an isolated state dir and a fixture team config installed into config/teams for the duration of a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIX = path.join(ROOT, "tests", "fixtures");
const TEAM_FILE = path.join(ROOT, "config", "teams", "fixture.json");

export function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "incident-bot-test-"));
  process.env.INCIDENT_BOT_STATE_DIR = stateDir;
  fs.copyFileSync(path.join(FIX, "team.json"), TEAM_FILE);
  return { stateDir, teardown() { try { fs.rmSync(TEAM_FILE); } catch { /* ignore */ } fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

export function fixture(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8")); }
