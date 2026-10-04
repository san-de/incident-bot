# DM — optional, one per configured `output.dmUserIds` entry

Rendered by `scripts/render.mjs dm`. Short: the person clicks through to the thread.

```text
{{signature}}
*[{{alert_code}}] {{service}}* · *{{classification}}*
{{one_line}}
Proposal: {{proposal}}
<{{thread_permalink}}|alert thread>{{#if gaps}} · Gaps: {{gaps}}{{/if}}
```
