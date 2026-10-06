---
name: incident-bot-poll
description: Hourly unattended poll for one team. Use when asked to "run the incident-bot poll for <team>", "check what <team> got tagged on", or when an Agent1 scheduled task says "poll --team <team>". Scans the configured Slack channels for new tags of the team's user group, and only when there are candidates runs the triage chunks (context → logs ‖ git → synthesize → post → ledger → optional Jira). Never asks questions; degrades and records gaps.
---

# incident-bot · poll

`${REPO}` is the clone of this repository (the Agent1 task description names it; locally it is the repo root). Every command below is
`node ${REPO}/scripts/<name>.mjs …`. Team config: `config/teams/<team>.json`. State: outside the repo (`config.mjs resolve` prints the paths).

## Hard rules

1. **Deterministic first.** Matching, dedupe, windows, targets, state come from the scripts. You interpret Kibana and code findings and write `report.json`; you never decide "this looks like a tag" by eye and never edit ledger JSON.
2. **Writes are limited to** what `post.mjs plan` lists: the tagged alert thread, `output.teamChannelId`, `output.dmUserIds`, the ledger, the overlay file. Never `reply_broadcast`, never reactions, never any other channel, never a repo, never Kibana.
3. **Secrets stay inside the scripts.** Never `cat`, print or copy a keys file. Never put a key in a command line.
4. **Never invent a number.** A count needs `kibana.mjs count|histogram` output or a Kibana-agent aggregation behind it.
5. **Unattended-safe.** Never ask. Degrade, record under gaps, continue. Resolve MCP tools by name suffix (`slack_send_message`, `ask_app_debugging`, prefer the `-prod` Kibana server).
6. **Send first, mark after.** `post.mjs mark` immediately after every successful Slack write. A failed write leaves the entry for the next run.
7. **Time budget.** Stop starting new candidates `poll.timeBudgetMinutes` (45) after the run began.

## Phase 0 — guard (always, first)

```
node ${REPO}/scripts/guard.mjs --team <team>
```
Exit 6 → **stop the run**. Print the `stop_reason` line, write the memory line with `gaps=guard:<reason>`, and if a Slack send tool exists post one line to `output.teamChannelId`: `⛔ incident-bot <team>: run could not start — <reason>`. Nothing else.
Exit 0 → `node ${REPO}/scripts/config.mjs resolve --team <team>` → keep as **CFG** for the run (channels, `derived.matchTokens`, output targets, kibana env, paths). Confirm the Slack search and send tools exist (hard: stop with one line if missing). Note the run start time.

## Phase 1 — find new tagged messages (deterministic)

Search is the primary source because `conversations.history` never returns thread replies, and most tags are the `sre` bot's thread reply `<!subteam^S…|handle>, please take a look: *[SRE00xx]: … | <service>*`.

1. `effectiveStart = min(now − poll.sinceFallbackMinutes, ledger watermarkTs)`; `--since <Nd|Nh>` overrides; a permalink → that message only.
2. For each `slack.channels[i]` × `slack.searchTerms[j]`: `slack_search_public_and_private query="in:#<name> <term>" after=<effectiveStart> include_bots=true sort=timestamp sort_dir=asc limit=20`, follow `cursor`. Hits from the `sre` bot come back with empty text: for every hit call `slack_read_thread channel_id=<id> message_ts=<thread_ts or ts>` and collect the thread messages.
3. `slack_read_channel <id> oldest=<effectiveStart>` for tagged **parent** messages that search has not indexed yet. **Paginate**: one page is never the whole window on a busy channel. Repeat the read with `latest=<oldest ts of the previous page>` (or follow its cursor) until a page's oldest message is older than `effectiveStart` or the page is empty; cap at 20 pages and record `gap: channel read capped` if hit.
4. Write `{ hits:[{ts, threadTs, channelId, text, user, permalink}], threads:{threadTs:[{ts,text,user}]} }` to a temp file and run
   `node ${REPO}/scripts/match.mjs --team <team> --file <tmp>` → **candidates.json**. Use its `candidates` as-is. It groups repeats: one candidate per alert+service (`alertKey`), the other tags of the same alert in `repeats`, and it suppresses alerts already analysed within `skip.repeatWindowHours` (24 h default). For every `skipped` entry: `node ${REPO}/scripts/ledger.mjs mark --team <team> <ts> --json '{"status":"skipped","reason":"…"}'` (not for `deferred: true`).
5. **No candidates → the run ends here.** Print `no new tags for <team> since <watermark local>`, `ledger.mjs advance <now − poll.searchLagMinutes>` (never `now`), `ledger.mjs run-note --team <team> --json '{"candidates":0,"posted":0,"skipped":<n>,"failed":0,"durationSec":<s>,"gaps":""}'`, the memory line, the terminal summary. Do not read any reference file, do not call Kibana or GitHub.

### Phase 1b — preflight (only when candidates exist)

`node ${REPO}/scripts/preflight.mjs --team <team>` once. Each entry in its `gaps` becomes a gap in every report of this run, never a stop.

## Phase 2 — context (per candidate, deterministic)

Write the candidate (one entry of candidates.json) and its thread (oldest first, parent first) to temp files, then
`node ${REPO}/scripts/context.mjs --team <team> --candidate <c.json> --thread <t.json>` → **context.json**: service, error.id, fixed UTC window, deploy anchor from the SRE reply, repo mapping, links, gaps. Reuse `window_utc` verbatim in every later question. Read `${REPO}/.claude/skills/_shared/references/kibana-links.md` only if `context.mjs` reports a link it could not resolve.

## Phase 3 and 4 — logs and git, in parallel

Spawn two Agent-tool subagents at once with the briefs in `${REPO}/briefs/log-correlator.md` and `${REPO}/briefs/git-correlator.md`, each given context.json verbatim and the `${REPO}` path. They return **logs.json** and **git.json** in the shapes the briefs define. If the Agent tool is unavailable, do both yourself in that order, following the same briefs.

## Phase 5 — synthesize (the only judgment step)

With context.json, logs.json and git.json in front of you, write **report.json** exactly in this shape; no other keys:

```json
{ "classification": "new after deploy | pre-existing, grew | pre-existing, flat | upstream dependency | infra | expected business validation | steady noise | unknown",
  "what": "2–3 sentences: symptom, service, when (Berlin time), how many, delta vs the previous window",
  "where": "repo — path:line (Class#method) · last touched sha \"subject\" (date), or null",
  "read": "1–2 sentences: why it fails, ours or upstream, how long",
  "one_line": "≤ 120 chars for the team channel",
  "next_action": "one concrete action for a human",
  "evidence": ["`Exception: message` — n× in window, first t, trace.id, error.id", "request story", "<kibana_url|Kibana>"],
  "open_points": "questions only the team can answer, or \"none\"",
  "kibana": { "service": "…", "window_utc": "from..to", "count": 142, "baseline_count": 2, "signature": "…", "first_app_frame": "…" },
  "git": { "repo": "…", "last_deploy": "ISO or null", "suspects": [ { "ref": "sha or #PR", "title": "…", "why": "…" } ] },
  "gaps": ["…"] }
```
Known issue or known noise in context.json matching `error.id` or the exception → say so in `read` and classify `steady noise` or `pre-existing, flat`.

## Phase 6 — post and mark

1. `node ${REPO}/scripts/post.mjs plan --team <team> --report report.json --context context.json [--dry-run]` → items in `send_order`. Dry run → print the texts, mark `{"status":"dry-run"}`, continue.
2. For each item: `slack_send_message` with exactly the `channel_id`, `thread_ts` and `text` given. Never add `reply_broadcast`. After the thread reply succeeds, re-render the team post with `render.mjs team --reply-ts <returned ts>` so it links to the reply.
3. After each success: `node ${REPO}/scripts/post.mjs mark --team <team> --ts <cand ts> --status posted --thread-ts <thread_ts> --reply-ts <returned ts> [--team-ts <ts>] --classification "<…>" --alert-key "<cand.alertKey>" --repeats <cand.repeats.length>`. The alert key is what suppresses the same alert for the next 24 h, so never omit it. Thread reply refused twice → post the full body to the team channel with the fallback prefix from `templates/team-channel.md`, mark `team-only`. When `repeats` is non-empty, say so in the reply (`fired N× in this window; this is the first read`), and do not reply in the repeat threads.
4. New service → repo mapping discovered by git-correlate → append it to the overlay file (`CFG.overlayPath`), never to `config/services.json`.

## Phase 7 — Jira (only when `jira.enabled` and `jira.createVia` ≠ none)

`node ${REPO}/scripts/jira.mjs classify --team <team> --report report.json`. `should_create: false` → skip. Otherwise follow the `incident-bot-jira-ticket` skill in unattended mode (no questions: project, labels and epic from config). **Dry run → no Jira write at all**: run the skill up to the payload, print `mcp_call`, and mark the ledger entry `dry-run`. Live → the three dedupe layers, the quarter epic rule, create, then `post.mjs mark … --ticket <KEY> --error-id … --service … --signature …` and `Filed <KEY>` appended to the thread reply.

## End of run

`ledger.mjs advance <…>`: when candidates.json has `deferredOldestTs`, advance to **at most** `deferredOldestTs − 0.000001` so the deferred ones are found next run; otherwise to `now − searchLagMinutes`. Never advance past a candidate that was not processed; `ledger.mjs run-note --team <team> --json '{"candidates":n,"posted":n,"teamOnly":n,"skipped":n,"failed":n,"durationSec":s,"gaps":"…"}'`; if `lastSuccessfulRunAt` is older than 2 h post the health line from `templates/team-channel.md`. Append the memory line `<ISO> <team> candidates=<n> posted=<n> skipped=<n> failed=<n> gaps=<…>`. Terminal summary: one line per candidate, then `watermark <ts> (<local>) · ledger <path> · version <VERSION>`.
