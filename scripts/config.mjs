#!/usr/bin/env node
// Team configuration: list, resolve, validate. Deterministic, no secrets printed. (Was monitor.js.)
//
//   node scripts/config.mjs list
//   node scripts/config.mjs resolve  [--team remex]      # merged config + runtime facts as JSON
//   node scripts/config.mjs validate [--team remex]      # exit 2 on errors; JSON report for every team when --team is omitted
//
// Runtime facts: mode (agent1 when /app/task-context exists, else local), repoRoot, stateDir
// ($INCIDENT_BOT_STATE_DIR, else /app/task-context/incident-bot on Agent1, else ~/.claude/incident-bot),
// per-team ledger/overlay paths, and where the Kibana key would come from (source only, never the value).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT, nowTs } from "./lib/cli.mjs";
import { resolveElasticKey, describe } from "./lib/elastic-key.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEAMS_DIR = path.join(REPO_ROOT, "config", "teams");
const ID = { channel: /^[CG][A-Z0-9]{8,}$/, subteam: /^S[A-Z0-9]{8,}$/, user: /^[UW][A-Z0-9]{8,}$/ };

export function listTeams() {
  if (!fs.existsSync(TEAMS_DIR)) return [];
  return fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith(".json")).sort().map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, f), "utf8"));
    return { file: f, team: raw.team || f.replace(/\.json$/, ""), enabled: raw.enabled !== false, example: f.startsWith("_") };
  });
}

export function loadTeam(team) {
  const file = path.join(TEAMS_DIR, `${team}.json`);
  if (!fs.existsSync(file)) throw new Error(`no team config ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.team = cfg.team || team;
  cfg._file = file;
  return cfg;
}

export function pickTeam(arg) {
  if (arg) return arg;
  const enabled = listTeams().filter(m => m.enabled && !m.example);
  if (enabled.length === 1) return enabled[0].team;
  throw new Error(`--team is required (enabled teams: ${enabled.map(m => m.team).join(", ") || "none"})`);
}

export function runtime() {
  const agent1 = fs.existsSync("/app/task-context");
  const stateDir = process.env.INCIDENT_BOT_STATE_DIR || (agent1 ? "/app/task-context/incident-bot" : path.join(os.homedir(), ".claude", "incident-bot"));
  return { mode: agent1 ? "agent1" : "local", stateDir, repoRoot: REPO_ROOT };
}

export function derivedTokens(cfg) {
  const s = cfg.slack || {};
  if (Array.isArray(s.matchTokens) && s.matchTokens.length) return s.matchTokens;
  const t = [];
  for (const id of s.subteamIds || []) t.push(`<!subteam^${id}`, `<@${id}`);
  for (const term of s.searchTerms || []) t.push(`|${term}>`);
  return t;
}

export function resolve(team) {
  const cfg = loadTeam(team);
  const rt = runtime();
  const teamStateDir = path.join(rt.stateDir, cfg.team);
  const services = cfg.services || {};
  return Object.assign({}, cfg, {
    derived: { matchTokens: derivedTokens(cfg) },
    mode: rt.mode,
    repoRoot: rt.repoRoot,
    version: fs.existsSync(path.join(rt.repoRoot, "VERSION")) ? fs.readFileSync(path.join(rt.repoRoot, "VERSION"), "utf8").trim() : null,
    stateDir: rt.stateDir,
    teamStateDir,
    ledgerPath: path.join(teamStateDir, "ledger.json"),
    overlayPath: path.join(teamStateDir, services.overlay || "services.local.json"),
    reposDir: path.join(rt.stateDir, "repos"),
    servicesPath: path.join(rt.repoRoot, services.file || "config/services.json"),
    elasticKey: describe(resolveElasticKey((cfg.kibana || {}).env || "prod")),
    nowTs: nowTs(),
  });
}

export function validate(team) {
  const errors = [], warnings = [];
  let cfg;
  try { cfg = loadTeam(team); } catch (e) { return { team, ok: false, errors: [e.message], warnings }; }
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  const warn = (cond, msg) => { if (!cond) warnings.push(msg); };
  req(typeof cfg.team === "string" && /^[a-z0-9-]+$/.test(cfg.team), "team must be lowercase letters/digits/hyphens");
  const s = cfg.slack || {};
  req(Array.isArray(s.channels) && s.channels.length > 0, "slack.channels must list at least one {id,name}");
  for (const c of s.channels || []) {
    req(c && ID.channel.test(String(c.id || "")), `slack.channels: bad channel id ${JSON.stringify(c && c.id)} (expected C… or G…)`);
    req(c && typeof c.name === "string" && c.name && !c.name.startsWith("#"), `slack.channels: name without '#' required for ${JSON.stringify(c && c.id)}`);
  }
  req((s.subteamIds || []).length || (s.matchTokens || []).length, "slack.subteamIds or slack.matchTokens required");
  for (const id of s.subteamIds || []) req(ID.subteam.test(id), `slack.subteamIds: bad id ${id}`);
  for (const id of s.ignoreSubteamIds || []) req(ID.subteam.test(id), `slack.ignoreSubteamIds: bad id ${id}`);
  req((s.searchTerms || []).length > 0, "slack.searchTerms required (used as 'in:#channel <term>' search)");
  const o = cfg.output || {};
  if (o.teamChannelId) {
    req(ID.channel.test(o.teamChannelId), `output.teamChannelId bad id ${o.teamChannelId}`);
    req(!(s.channels || []).some(c => c.id === o.teamChannelId), "output.teamChannelId must not also be a source channel (self-triggering loop)");
  }
  warn(o.threadReply !== false || o.teamChannelId || (o.dmUserIds || []).length, "no output configured (threadReply false, no team channel, no DMs)");
  for (const u of o.dmUserIds || []) req(ID.user.test(u), `output.dmUserIds: bad id ${u}`);
  req(typeof o.signature === "string" && o.signature.length > 8, "output.signature required (first line of every post, also the replied-guard marker)");
  const own = cfg.owner || {};
  req(own.name && ID.user.test(own.slackUserId || ""), "owner.name and owner.slackUserId (U…) required");
  const a1 = cfg.agent1 || {};
  if (cfg.enabled !== false && !team.startsWith("_")) {
    req(typeof a1.agentId === "string" && a1.agentId.length > 3, "agent1.agentId required for an enabled team (team-owned agent → per-team accounting)");
    req(typeof a1.boardId === "string" && a1.boardId.length > 3, "agent1.boardId required for an enabled team (team board → cost visible per team)");
    req(typeof a1.runAs === "string" && a1.runAs.length > 0, "agent1.runAs required: the service account name, or the person whose key runs the task until a service account exists");
  }
  const k = cfg.kibana || {};
  req(["prod", "qa"].includes(k.env || "prod"), "kibana.env must be prod or qa");
  warn(!k.askTool || !k.askTool.startsWith("mcp__"), "kibana.askTool should be a tool-name suffix (ask_app_debugging), not a full mcp__ name");
  const g = cfg.github || {};
  warn(!g.lookbackHours || (g.lookbackHours >= 1 && g.lookbackHours <= 24 * 14), "github.lookbackHours should be between 1 and 336");
  const j = cfg.jira;
  if (j && j.enabled) {
    const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
    req(typeof j.project === "string" && /^[A-Z][A-Z0-9]+$/.test(j.project), "jira.project must be a Jira project key when jira.enabled");
    req(!j.epics || Object.values(j.epics).every(v => KEY.test(v || "")), "jira.epics values must be issue keys (PROJ-123)");
    req(Array.isArray(j.labels) && j.labels.length > 0, "jira.labels must list at least one label");
    req(Array.isArray(j.createFor) && j.createFor.length > 0, "jira.createFor must list at least one classification");
    req(["webhook", "mcp", "none"].includes(j.createVia || "none"), "jira.createVia must be webhook | mcp | none");
    warn(/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/.test(j.siteUrl || ""), "jira.siteUrl should be the https://<site>.atlassian.net base URL");
  }
  return { team: cfg.team, file: cfg._file, ok: errors.length === 0, errors, warnings };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0];
  try {
    if (cmd === "list") return out(listTeams());
    if (cmd === "resolve") return out(resolve(pickTeam(opt.team)));
    if (cmd === "validate") {
      const teams = opt.team ? [opt.team] : listTeams().filter(m => !m.example).map(m => m.team);
      const reports = teams.map(validate);
      out(reports);
      process.exit(reports.every(r => r.ok) ? EXIT.OK : EXIT.USAGE);
    }
    fail("config", "usage: config.mjs list | resolve [--team <team>] | validate [--team <team>]", EXIT.USAGE);
  } catch (e) { fail("config", e.message, EXIT.USAGE); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
