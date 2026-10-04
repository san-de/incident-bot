# incident-bot

Unattended Slack alert triage for AUTO1 teams, split into small deterministic chunks, hosted on Agent1 as a task
project clone. One tagged alert in, one analysis out: who tagged us, what Kibana says, where in the code, what to do
next, posted where the team reads it, and optionally filed in Jira.

Successor to `rota-triage-bot`. Same rules, three structural changes: the run is a pipeline of eight small pieces with
JSON contracts between them, the only model step is synthesis, and a run that cannot start says so instead of
completing quietly.

```
slack-scan ─▶ tags? ─no─▶ end ($0 model)
              │yes
              ▼
        alert-context ─▶ log-correlate ─┐
                      └▶ git-correlate ─┴▶ synthesize ─▶ slack-report ─▶ ledger ─▶ jira-create (optional)
```

| Piece | Owns | In → out | Where |
|---|---|---|---|
| slack-scan | Slack read (MCP) + `scripts/match.mjs` | config, ledger → candidates.json | skill `incident-bot-slack-scan`, part of poll |
| alert-context | nothing | candidate + thread → context.json | `scripts/context.mjs` (+ `links.mjs`) |
| log-correlate | Kibana key | context → logs.json | `briefs/log-correlator.md` + `scripts/kibana.mjs` |
| git-correlate | GitHub read | context + deploy anchor → git.json | `briefs/git-correlator.md` + `scripts/github.mjs` |
| synthesize | nothing, no tools | context + logs + git → report.json | the model, shape in `.claude/skills/poll/SKILL.md` |
| slack-report | Slack write (MCP) | report → thread reply, team post | `scripts/render.mjs` + `scripts/post.mjs` |
| ledger | state file | watermark, handled threads | `scripts/ledger.mjs` |
| jira-create | Jira (webhook / MCP) | report → ticket.json | skill `incident-bot-jira-ticket` + `scripts/jira.mjs` |

## Run it locally

```
npm test                                   # offline fixture tests
node scripts/config.mjs validate           # every team config
node scripts/guard.mjs --team remex        # can a run start? (exit 6 = no, with the reason)
node scripts/kibana.mjs key-check          # where would the Kibana key come from (source only)
```
Then open Claude Code in this directory with the Slack MCP configured and say `run the incident-bot poll for remex --dry-run`.
The skills in `.claude/skills/` are picked up automatically. `${REPO}` in the skills is this directory.

## Run it on Agent1

Nothing is committed to an Agent1 repository. `agent1/bootstrap.sh` creates the objects through the API, the way the
first REMEX task was created:

```
export AGENT1_API_KEY=…                                   # personal key, never printed
agent1/bootstrap.sh skill                                 # platform-hosted guard skill (then share it)
agent1/bootstrap.sh agents                                # incident-bot + 3 step agents
agent1/bootstrap.sh workflows                             # triage-one, jira-ticket
agent1/bootstrap.sh poll --team remex --repo https://github.com/<owner>/incident-bot --ref v1.0.0 --extra-args "--dry-run" --notify
agent1/bootstrap.sh watchdog --team remex
```
The poll task lists this repo as its project; the worker clones it at the tag. The guard skill runs before the clone is
trusted. After a week of clean dry runs, recreate the poll task without `--extra-args`.

Credentials: run the poll as a **service account** (GitHub PAT, Slack bot token, read-only Elastic key, Delorean key)
so nothing expires with a person. Until the account exists, the owner's saved GitHub PAT is the fallback.
Jira creation has no first-party path on Agent1 yet; `agent1/automations/jira-create.json` describes the automation
that fills the gap (`jira.createVia: webhook`).

## Onboarding a team

1. Copy `config/teams/_example.json` to `config/teams/<team>.json`, fill it, open a PR. CI validates it.
2. Add the team's service → repo mappings to `config/services.json` (or let the bot discover them into the overlay).
3. `agent1/bootstrap.sh poll --team <team> …` with `--extra-args "--dry-run"`, read the ledger and the team channel for a week.
4. Recreate without dry-run. Turn on `jira.enabled` by PR only after the analyses are trusted.

See `docs/operations.md` for the runbook and `AGENTS.md` for the rules when editing this repository.
