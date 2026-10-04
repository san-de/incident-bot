#!/usr/bin/env node
// Chunk 4, deterministic half: recent changes and frame lookup from a local shallow clone. Read-only.
// On Agent1 the clone goes through the worker's credential proxy; locally through your own git credentials.
// The model may use the GitHub MCP tools instead; this is the credential-free path when they are absent.
//
//   node scripts/github.mjs clone  --repo wkda/new-margin-service --repos-dir ~/.claude/incident-bot/repos [--depth 200] [--ref <tag>]
//   node scripts/github.mjs recent --repo-dir <dir> --anchor 2026-10-04T07:50:00Z [--lookback-hours 48] [--path-filter src/main]
//   node scripts/github.mjs frame  --repo-dir <dir> --frame 'com.auto1.margin.PriceService.compute(PriceService.java:142)' [--anchor ISO]
//   node scripts/github.mjs anchor --repo-dir <dir> --before ISO            # newest tag or merge before an instant (deploy anchor fallback)
//
// Output is JSON; nothing here writes to a remote. Exit 5 when the repo or frame is not found.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { redact } from "./lib/redact.mjs";

function git(dir, args, opts = {}) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout || 60000 }).trim();
}

export function parseFrame(frame) {
  const m = String(frame).match(/([\w.$]+)\.([\w$<>]+)\(([\w$]+\.(?:java|kt|scala)):(\d+)\)/);
  if (!m) return null;
  const cls = m[1].split("$")[0];
  return { className: cls, method: m[2], file: m[3], line: Number(m[4]), pathHint: cls.replace(/\./g, "/") + "." + m[3].split(".").pop() };
}

export function recentFromLog(logText) {
  // format: sha<US>iso<US>author<US>subject<RS>paths…
  return logText.split("\x1e").map(s => s.trim()).filter(Boolean).map(block => {
    const [head, ...paths] = block.split("\n");
    const [sha, at, author, subject] = head.split("\x1f");
    const pr = (subject || "").match(/\(#(\d+)\)\s*$|Merge pull request #(\d+)/);
    return { sha: (sha || "").slice(0, 10), at, author: redact(author || ""), subject: (subject || "").slice(0, 140), pr: pr ? Number(pr[1] || pr[2]) : null,
      paths: paths.map(p => p.trim()).filter(Boolean).slice(0, 30) };
  });
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0];
  try {
    if (cmd === "clone") {
      if (!opt.repo || !opt["repos-dir"]) fail("github", "clone needs --repo owner/name --repos-dir <dir>", EXIT.USAGE);
      const dir = path.join(opt["repos-dir"], opt.repo.split("/")[1]);
      fs.mkdirSync(opt["repos-dir"], { recursive: true });
      const url = `https://github.com/${opt.repo}.git`;
      if (fs.existsSync(path.join(dir, ".git"))) {
        try { git(dir, ["fetch", "--quiet", "--depth", String(opt.depth || 200), "origin"], { timeout: 120000 }); } catch (e) { return out({ dir, fetched: false, warning: redact(String(e.stderr || e.message)).slice(0, 200) }); }
        return out({ dir, fetched: true, head: git(dir, ["rev-parse", "--short", "HEAD"]) });
      }
      const args = ["clone", "--quiet", "--depth", String(opt.depth || 200), "--no-tags"];
      if (opt.ref) args.push("--branch", opt.ref);
      execFileSync("git", [...args, url, dir], { stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
      return out({ dir, cloned: true, head: git(dir, ["rev-parse", "--short", "HEAD"]), branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) });
    }
    const dir = opt["repo-dir"];
    if (!dir || !fs.existsSync(path.join(dir, ".git"))) fail("github", `repo dir missing or not a clone: ${dir}`, EXIT.NOT_FOUND);
    if (cmd === "recent") {
      if (!opt.anchor) fail("github", "recent needs --anchor ISO", EXIT.USAGE);
      const anchor = new Date(opt.anchor); const lookback = Number(opt["lookback-hours"] || 48);
      const since = new Date(anchor.getTime() - lookback * 36e5);
      const args = ["log", `--since=${since.toISOString()}`, `--until=${anchor.toISOString()}`, "--date=iso-strict", "--name-only", "--format=%x1e%h%x1f%ad%x1f%an%x1f%s"];
      if (opt["path-filter"]) args.push("--", opt["path-filter"]);
      const commits = recentFromLog(git(dir, args));
      const merged = commits.filter(c => c.pr !== null);
      return out({ repo_dir: dir, anchor: anchor.toISOString(), since: since.toISOString(), lookback_hours: lookback,
        commits: commits.slice(0, 40), merged_prs: merged.slice(0, 20).map(c => ({ number: c.pr, title: c.subject, merged_at: c.at, sha: c.sha, paths: c.paths })),
        truncated: commits.length > 40 });
    }
    if (cmd === "frame") {
      const f = parseFrame(opt.frame);
      if (!f) fail("github", "frame not parseable; expected Class.method(File.java:123)", EXIT.USAGE);
      const files = git(dir, ["ls-files", `*${f.pathHint}`]).split("\n").filter(Boolean);
      if (!files.length) return out({ frame: f, found: false });
      const file = files[0];
      const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
      const lo = Math.max(0, f.line - 11), hi = Math.min(lines.length, f.line + 10);
      const lastArgs = ["log", "-1", "--date=iso-strict", "--format=%h%x1f%ad%x1f%an%x1f%s"];
      if (opt.anchor) lastArgs.push(`--until=${new Date(opt.anchor).toISOString()}`);
      lastArgs.push("-L", `${Math.max(1, f.line - 2)},${f.line + 2}:${file}`, "--no-patch");
      let last = null;
      try { const [sha, at, author, subject] = git(dir, lastArgs).split("\n")[0].split("\x1f"); last = { sha, at, author: redact(author), subject }; } catch { /* -L unsupported on shallow history */ }
      if (!last) { try { const [sha, at, author, subject] = git(dir, ["log", "-1", "--date=iso-strict", "--format=%h%x1f%ad%x1f%an%x1f%s", "--", file]).split("\x1f"); last = { sha, at, author: redact(author), subject }; } catch { /* ignore */ } }
      return out({ frame: f, found: true, path: file, line: f.line, excerpt: lines.slice(lo, hi).map((l, i) => `${lo + i + 1}: ${l}`), last_touched: last,
        blob_url_hint: `https://github.com/<owner>/<repo>/blob/<ref>/${file}#L${f.line}` });
    }
    if (cmd === "anchor") {
      const before = opt.before ? new Date(opt.before).toISOString() : new Date().toISOString();
      let tag = null;
      try { tag = git(dir, ["log", "-1", `--until=${before}`, "--format=%h%x1f%ad%x1f%D", "--date=iso-strict", "--simplify-by-decoration"]); } catch { /* ignore */ }
      const [sha, at, deco] = (tag || "").split("\x1f");
      const merge = git(dir, ["log", "-1", "--merges", `--until=${before}`, "--format=%h%x1f%ad%x1f%s", "--date=iso-strict"]).split("\x1f");
      return out({ before, newest_decorated: sha ? { sha, at, refs: deco } : null, newest_merge: merge[0] ? { sha: merge[0], at: merge[1], subject: merge[2] } : null,
        anchor: (merge[1] || at) || null, source: merge[1] ? "last-merge" : (at ? "last-tag" : "none") });
    }
    fail("github", "usage: github.mjs clone|recent|frame|anchor …", EXIT.USAGE);
  } catch (e) {
    if (e && e.status !== undefined) fail("github", redact(String(e.stderr || e.message)).slice(0, 300), EXIT.ERROR);
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
