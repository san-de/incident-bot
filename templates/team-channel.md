# Team channel post — one short message per tagged alert, posted in `output.teamChannelId`

Rendered by `scripts/render.mjs team --reply-ts <ts>` after the thread reply succeeded, so it can link to it. Under 600 characters.

```text
🔎 *[{{alert_code}}] {{service}}* · *{{classification}}* · tagged by {{tagger}} {{t_local}}
{{one_line}} · Proposal: {{proposal}}
<{{thread_permalink}}|alert thread>{{#if reply_permalink}} · <{{reply_permalink}}|triage reply>{{/if}}{{#if gaps}} · Gaps: {{gaps}}{{/if}}
```

## Fallback when the thread reply failed

If the Slack send into the alert thread was refused twice (for example a channel the runner cannot post into), post the
**full thread-reply body** to the team channel instead, prefixed with one line:

```
⚠ could not reply in <{{thread_permalink}}|the alert thread> ({{reason}}) — analysis below
```

and mark the entry with `status: "team-only"`. Never post drafts and never post into any other channel.

## Health line (once per run, only when needed)

When `ledger.mjs run-note` reports `lastSuccessfulRunAt` older than 2 hours (or null with a ledger that has runs), post one line:

```
⏱ incident-bot for @{{team}}: no successful run since {{last_success_local}} — check the Agent1 task "incident-bot · poll · {{team}}"
```
