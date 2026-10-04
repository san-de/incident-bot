#!/usr/bin/env node
// Chunk 6, second half: the write gate. The model never decides where to post; it asks this script for a plan,
// sends each item with the Slack MCP tool, then marks the ledger with the returned ts. Send first, mark after.
//
//   node scripts/post.mjs plan  --team remex --report report.json --context context.json [--dry-run]
//       → { items: [ {kind:"thread", channel_id, thread_ts, text} , {kind:"team", channel_id, text} , {kind:"dm", user_id, text} ], refused: [] }
//   node scripts/post.mjs check --team remex --channel C… [--thread-ts ts]        # exit 0 if that target is allowed, 6 otherwise
//   node scripts/post.mjs mark  --team remex --ts <cand ts> --status posted --thread-ts <ts> --reply-ts <ts> [--team-ts <ts>] [--classification x] [--ticket KEY]
//
// Allowed targets, and nothing else: the candidate's own thread in a configured source channel, output.teamChannelId,
// output.dmUserIds. reply_broadcast is never allowed. A refused target is listed, never silently dropped.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { readJson } from "./lib/io.mjs";
import { resolve, pickTeam } from "./config.mjs";
import { render } from "./render.mjs";
import { mark } from "./ledger.mjs";

export function allowedTarget(cfg, channelId, threadTs, ctx) {
  const o = cfg.output || {};
  const source = (cfg.slack.channels || []).some(c => c.id === channelId);
  if (source) return threadTs && ctx && threadTs === ctx.thread_ts && channelId === ctx.channel_id ? { ok: true, kind: "thread" } : { ok: false, reason: "source channel: only the candidate's own thread is allowed" };
  if (o.teamChannelId && channelId === o.teamChannelId) return threadTs ? { ok: false, reason: "team channel: top-level posts only" } : { ok: true, kind: "team" };
  if ((o.dmUserIds || []).includes(channelId)) return { ok: true, kind: "dm" };
  return { ok: false, reason: "channel not in the team's output config" };
}

export function plan(cfg, report, ctx, dryRun) {
  const o = cfg.output || {};
  const items = [], refused = [];
  if (o.threadReply !== false) {
    const t = allowedTarget(cfg, ctx.channel_id, ctx.thread_ts, ctx);
    if (t.ok) items.push(Object.assign({ kind: "thread", channel_id: ctx.channel_id, thread_ts: ctx.thread_ts, reply_broadcast: false }, render("thread", cfg, report, ctx)));
    else refused.push({ kind: "thread", channel_id: ctx.channel_id, reason: t.reason });
  }
  if (o.teamChannelId) items.push(Object.assign({ kind: "team", channel_id: o.teamChannelId, note: "fill reply_permalink after the thread reply succeeds: render.mjs team --reply-ts <ts>" }, render("team", cfg, report, ctx)));
  for (const u of o.dmUserIds || []) items.push(Object.assign({ kind: "dm", user_id: u }, render("dm", cfg, report, ctx)));
  return { team: cfg.team, dry_run: !!dryRun || o.dryRun === true, send_order: ["thread", "team", "dm"], items, refused,
    after_each_success: "node scripts/post.mjs mark --team <team> --ts <cand ts> --status posted --thread-ts <thread_ts> --reply-ts <returned ts>" };
}

function main() {
  const opt = parseArgs(process.argv.slice(2), ["dry-run"]);
  const cmd = opt._[0];
  let cfg;
  try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("post", e.message, EXIT.USAGE); }
  if (cmd === "plan") {
    if (!opt.report || !opt.context) fail("post", "plan needs --report and --context", EXIT.USAGE);
    return out(plan(cfg, readJson(opt.report), readJson(opt.context), opt["dry-run"]));
  }
  if (cmd === "check") {
    const ctx = opt.context ? readJson(opt.context) : { channel_id: opt.channel, thread_ts: opt["thread-ts"] };
    const t = allowedTarget(cfg, opt.channel, opt["thread-ts"], ctx);
    out(Object.assign({ channel_id: opt.channel, thread_ts: opt["thread-ts"] || null }, t));
    process.exit(t.ok ? 0 : EXIT.GUARD);
  }
  if (cmd === "mark") {
    if (!opt.ts || !opt.status) fail("post", "mark needs --ts and --status", EXIT.USAGE);
    const entry = { status: opt.status };
    if (opt["thread-ts"]) entry.threadTs = opt["thread-ts"];
    if (opt["reply-ts"]) entry.threadReplyTs = opt["reply-ts"];
    if (opt["team-ts"]) entry.teamPostTs = opt["team-ts"];
    if (opt.classification) entry.classification = opt.classification;
    if (opt.ticket) entry.ticket = opt.ticket;
    if (opt.reason) entry.reason = opt.reason;
    return out(mark(cfg, opt.ts, entry));
  }
  fail("post", "usage: post.mjs plan|check|mark …", EXIT.USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
