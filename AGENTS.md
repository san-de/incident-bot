# Notes for agents editing this repository

- The skills under `.claude/skills/` run **unattended** on Agent1. Every change must keep them runnable without
  questions: degrade and record under *gaps*, never prompt. The only skill allowed to ask is `jira-ticket`, and only
  in interactive mode.
- **Deterministic first.** Anything expressible as a rule belongs in `scripts/` (guard, config, match, links, context,
  kibana, github, render, post, ledger, jira, redact). The model interprets; it never decides dedupe, matching, targets or state.
- **Chunks and contracts.** scan → candidates.json → context.json → logs.json ‖ git.json → report.json → post → ledger
  (→ jira). A chunk reads only its own inputs and returns `ok:false` plus a reason instead of throwing across the seam.
  Keep the JSON shapes in the briefs and in `.claude/skills/poll/SKILL.md` in sync with the scripts.
- **Agent1 is configured, not committed.** Nothing in this repo is committed to an Agent1-owned repository. `agent1/`
  holds the definitions; `agent1/bootstrap.sh` applies them through the API. The platform-hosted guard skill
  (`agent1/skills/incident-bot-guard/SKILL.md`) is the only code that runs when the clone is missing: keep it tiny
  and free of team config.
- On Agent1 the session's working directory is the workspace root, not this repo. Project hooks in
  `.claude/settings.json` and project subagents in `.claude/agents/` are therefore **not** loaded there. Guards live
  in the scripts (`post.mjs` target allowlist, `redact.mjs`, `guard.mjs`); fan-out uses the Agent tool with `briefs/*.md`.
- Bump `VERSION` on every change to `scripts/`, `.claude/skills/`, `briefs/`, `templates/` or `agent1/`. CI enforces it on PRs.
  The run note and the terminal summary print the version so a transcript says which code ran.
- Never commit state: `ledger.json`, `services.local.json`, key files, webhook files. State lives outside the repo
  (`INCIDENT_BOT_STATE_DIR`, `/app/task-context/incident-bot/<team>` on Agent1, `~/.claude/incident-bot/<team>` locally).
- Team config PRs must pass `node scripts/config.mjs validate`. Tests run offline: `npm test`.
- Secrets: the Kibana key is read only inside `scripts/lib/elastic-key.mjs` (env or `ELASTIC_API_KEY_FILE`); the Jira
  webhook secret only inside `scripts/jira.mjs`; the Agent1 key only inside `agent1/bootstrap.sh` through a curl config fd.
  Nothing ever echoes a key, and every error path goes through `redact()`.
- Templates (`templates/*.md`) define the exact Slack and Jira output; change them, not the skill prose, to change what gets posted.
