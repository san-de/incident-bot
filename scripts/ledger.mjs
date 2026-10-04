#!/usr/bin/env node
// Deterministic per-team state so an unattended run never hand-edits JSON. (Was ledger.js; v2 format unchanged.)
//
//   node scripts/ledger.mjs init        --team remex            # create the ledger if missing
//   node scripts/ledger.mjs status      --team remex
//   node scripts/ledger.mjs has         --team remex <ts>       # exit 0 if <ts> is already handled (posted/team-only/dm/draft/skipped)
//   node scripts/ledger.mjs has-thread  --team remex <thread_ts># exit 0 if we already replied in that thread
//   node scripts/ledger.mjs mark        --team remex <ts> --json '{"status":"posted","threadTs":"…","threadReplyTs":"…"}'
//   node scripts/ledger.mjs advance     --team remex <ts>       # forwards-only watermark move
//   node scripts/ledger.mjs run-note    --team remex --json '{"candidates":3,"posted":2,"skipped":1,"failed":0,"durationSec":410,"gaps":""}'
//
// Writes are atomic (tmp + rename). The ledger path comes from config.mjs (state dir outside the repo).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT, nowIso, nowTs } from "./lib/cli.mjs";
import { readJsonIf, writeAtomic } from "./lib/io.mjs";
import { resolve, pickTeam } from "./config.mjs";

export const HANDLED = new Set(["posted", "team-only", "dm", "draft", "skipped"]);   // dry-run and failed are retried by a live run

function fresh(cfg) {
  const lookbackH = ((cfg.poll || {}).firstRunLookbackHours) || 2;
  return { version: 2, team: cfg.team, watermarkTs: (Date.now() / 1000 - lookbackH * 3600).toFixed(6), updatedAt: nowIso(), processed: {}, repliedThreads: {}, runs: [] };
}

export function load(cfg) { return readJsonIf(cfg.ledgerPath, null); }

export function init(cfg) {
  let led = load(cfg);
  let created = false;
  if (!led) { created = true; led = fresh(cfg); writeAtomic(cfg.ledgerPath, led); }
  return { path: cfg.ledgerPath, watermarkTs: led.watermarkTs, created, processed: Object.keys(led.processed).length };
}

function mustLoad(cfg) {
  const led = load(cfg);
  if (!led) fail("ledger", `not initialised — run: ledger.mjs init --team ${cfg.team}`, EXIT.STATE);
  if (led.version !== 2) fail("ledger", `unexpected version ${led.version} at ${cfg.ledgerPath}`, EXIT.STATE);
  return led;
}

export function mark(cfg, ts, entry) {
  const led = mustLoad(cfg);
  const prev = led.processed[ts] || {};
  const merged = Object.assign({}, prev, entry, { processedAt: entry.processedAt || nowIso() });
  led.processed[ts] = merged;
  if (merged.threadTs && merged.threadReplyTs) led.repliedThreads[merged.threadTs] = merged.threadReplyTs;
  led.updatedAt = nowIso();
  writeAtomic(cfg.ledgerPath, led);
  return { ts, status: merged.status, repliedThread: !!(merged.threadTs && merged.threadReplyTs) };
}

export function advance(cfg, ts) {
  const led = mustLoad(cfg);
  const moved = Number(ts) > Number(led.watermarkTs);
  if (moved) { led.watermarkTs = ts; led.updatedAt = nowIso(); writeAtomic(cfg.ledgerPath, led); }
  return { watermarkTs: led.watermarkTs, moved };
}

export function runNote(cfg, note) {
  const led = mustLoad(cfg);
  led.runs.push(Object.assign({ at: nowIso(), mode: cfg.mode, version: cfg.version }, note));
  if (led.runs.length > 50) led.runs = led.runs.slice(-50);
  led.updatedAt = nowIso();
  writeAtomic(cfg.ledgerPath, led);
  const lastOk = [...led.runs].reverse().find(r => (r.failed || 0) === 0 && r.status !== "failed");
  return { runs: led.runs.length, lastSuccessfulRunAt: lastOk ? lastOk.at : null };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0], pos = opt._.slice(1);
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("ledger", e.message, EXIT.USAGE); }
  const json = () => { try { return opt.json ? JSON.parse(opt.json) : {}; } catch { fail("ledger", "--json is not valid JSON", EXIT.USAGE); } };

  switch (cmd) {
    case "init": return out(init(cfg));
    case "status": {
      const led = mustLoad(cfg);
      const byStatus = {};
      for (const e of Object.values(led.processed)) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      return out({ path: cfg.ledgerPath, watermarkTs: led.watermarkTs, watermarkIso: new Date(Number(led.watermarkTs) * 1000).toISOString(),
        processed: Object.keys(led.processed).length, byStatus, repliedThreads: Object.keys(led.repliedThreads).length, lastRun: led.runs.at(-1) || null, updatedAt: led.updatedAt });
    }
    case "has": {
      const e = mustLoad(cfg).processed[pos[0]];
      const yes = !!(e && HANDLED.has(e.status));
      out({ ts: pos[0], handled: yes, status: e ? e.status : null });
      process.exit(yes ? 0 : 1);
    }
    case "has-thread": {
      const r = mustLoad(cfg).repliedThreads[pos[0]];
      out({ threadTs: pos[0], replied: !!r, threadReplyTs: r || null });
      process.exit(r ? 0 : 1);
    }
    case "mark": {
      if (!pos[0] || !opt.json) fail("ledger mark", "<ts> and --json required", EXIT.USAGE);
      return out(mark(cfg, pos[0], json()));
    }
    case "advance": {
      if (!pos[0] || !/^\d+(\.\d+)?$/.test(pos[0])) fail("ledger advance", "<ts> (Slack ts or unix seconds) required", EXIT.USAGE);
      return out(advance(cfg, pos[0]));
    }
    case "run-note": return out(runNote(cfg, json()));
    default: fail("ledger", "usage: ledger.mjs init|status|has <ts>|has-thread <thread_ts>|mark <ts> --json|advance <ts>|run-note --json  --team <team>", EXIT.USAGE);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
