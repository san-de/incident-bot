#!/usr/bin/env node
// Phase 1b preflight: where would each credential come from? Sources only, never values. Runs only when candidates exist.
//
//   node scripts/preflight.mjs --team remex
//
// Output: { kibana:{source,slot,reason}, github:{gh,git}, jira:{createVia, webhook:"env"|"file"|"none"}, slackTools:"check in session" }
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { resolve, pickTeam } from "./config.mjs";
import { resolveElasticKey, describe } from "./lib/elastic-key.mjs";

const opt = parseArgs(process.argv.slice(2));
let cfg;
try { cfg = resolve(pickTeam(opt.team)); } catch (e) { fail("preflight", e.message, EXIT.USAGE); }

function has(bin, args) { try { execFileSync(bin, args, { stdio: "ignore", timeout: 8000 }); return true; } catch { return false; } }

const kib = describe(resolveElasticKey((cfg.kibana || {}).env || "prod"));
const gh = has("gh", ["auth", "status"]);
const git = has("git", ["--version"]);
const jiraVia = (cfg.jira || {}).createVia || "none";
const webhook = process.env.INCIDENT_BOT_JIRA_WEBHOOK_URL ? "env" : (process.env.INCIDENT_BOT_JIRA_WEBHOOK_FILE && fs.existsSync(process.env.INCIDENT_BOT_JIRA_WEBHOOK_FILE) ? "file" : "none");
const gaps = [];
if (kib.source === "none") gaps.push(`Kibana key for scripts: ${kib.reason}`);
if (!gh) gaps.push("gh not authenticated: use the GitHub MCP tools or github.mjs clone (credential proxy)");
if ((cfg.jira || {}).enabled && jiraVia === "webhook" && webhook === "none") gaps.push("Jira webhook not configured; tickets will not be created");

out({ team: cfg.team, mode: cfg.mode, version: cfg.version, kibana: kib, github: { gh, git, reposDir: cfg.reposDir }, jira: { enabled: !!(cfg.jira || {}).enabled, createVia: jiraVia, webhook },
  slackTools: "verify in session: slack_search_public_and_private, slack_read_thread, slack_read_channel, slack_send_message", gaps });
