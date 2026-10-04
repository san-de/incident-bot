# Kibana agent question sequence (PROD App Debugging, one conversation per alert)

Substitute `{service}`, `{from}`, `{to}` (ISO-8601 UTC, identical in every question), `{prev_from}` = `{from} - (to - from)`, `{error_id}`, `{trace_id}`, `{exception}` when known. Ask in this order; each answer shapes the next. A count is only a count when the answer's `tools_run` shows an aggregation (`auto1.count_matching_logs`, `auto1.level_histogram`, `auto1.exceptions`); a page of raw hits is not a count.

**Q1 — Volume and levels**
> For service.name "{service}", give the log level histogram (ERROR / WARN / INFO / no-level counts) for the window {from} to {to} UTC, and the ERROR count for the preceding window {prev_from} to {from} UTC. Answer as INLINE PLAIN TEXT.

**Q2 — Error signatures** (when `{error_id}` is known, ask this first with `and error.id "{error_id}"`, then once more without the restriction)
> For service.name "{service}" between {from} and {to} UTC, list the top 5 ERROR signatures by count. For each give: exception class, the message text (not only a hash, first 160 characters), the top stack frame whose package starts with wkda. or com.auto1. (class#method:line), the logger, first seen, last seen, count, and one representative trace.id. Answer as INLINE PLAIN TEXT, one line per signature.

If it returns hashes only, in the same conversation:
> For each signature hash above, give the message text and the top wkda./com.auto1. stack frame. Inline plain text.

**Q3 — Request story for the representative trace**
> For trace.id "{trace_id}", give the request story in order: the entry endpoint (http.request.method + url.path), each downstream call the service made (target service or host, status, duration), where the exception was thrown, and the final http.response.status_code. Answer as INLINE PLAIN TEXT, one line per hop.

**Q4 — Performance (only if the thread or signatures mention timeout, latency, DB, pool, 5xx)** — fresh conversation with the Performance tool
> For service "{service}", compare {from}–{to} UTC with {prev_from}–{from} UTC: request count, 5xx count, 4xx count, p50/p95/p99 latency. Also list any deploy or version change for the service inside {from}–{to}. Answer as INLINE PLAIN TEXT.

**Q5 — Presence check (only when Q2 finds nothing but the alert names an error)**
> Are there ANY logs for service.name "{service}" containing "{exception}" in the last 10 days? Give presence, count, first_seen, last_seen. Inline plain text.

## Index coverage

The App Debugging agent queries `logs-auto1.services-*` only. Alert links often use the data view `*beat-*`; a service whose logs live there (seen 2026-09-07: `public-remarketing`, account b2x) returns **0 signatures** from the agent even while the alert is firing. Zero from the agent is therefore not "no errors": when Q1/Q2 return 0 for a service the alert names, record `service not visible to the Kibana agent (*beat-* index)` under Gaps and rely on the thread's pasted trace and the Discover link. A `conversation_degraded: true` flag on an answer means a tool call failed inside the agent — re-ask once in a fresh conversation before trusting it.

When the agent returns 0 for a firing alert, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kibana.mjs" --service <svc> --error-id <id> --days 10` (Phase 3b in SKILL.md): it reads the same data through Kibana's internal search endpoint and finds exceptions the agent misses (those with `error.type` unset, where the class is only in `error.stack_trace`). Narrow with `--index "*logs-auto1.services*"` for window scans — a wildcard index with a short window can time out.

## Historical windows (older than ~24 h)

Verified 2026-09-07 on a 3-day-old window: `auto1.level_histogram` "could not query this absolute historical window", raw retrieval is a **capped newest-first sample of 1,000 rows**, and `log.logger` is not among the retrieved fields. What still works: `count_matching_logs` / `count_matching_logs_all_terms` (exact counts for phrases), `count_logs_by_timerange` (total lines), `exceptions`, `service_error_count`. So for windows older than a day phrase the questions as counts of specific phrases/exception classes, not as histograms, and never treat the 1,000-row sample as complete. `[SRE0058] Slow queries` lines (Tomcat `SlowQueryReport` logger, "Slow Query Report SQL=…; time=…ms") returned **0** from the agent for a window where the alert fired — treat slow-query alerts as *not observable* through the agent for now: Gaps `slow-query lines not visible to the Kibana agent`, and rely on the Discover link + code.

## Retention

The App Debugging agent sees the last **10 days** only. A window older than that returns a *substitute* answer ("outside the 10-day retention period … fallback window: last 24 hours") — those numbers are not the alert's. Skip Q1–Q3, run Q5 for the exception class, and say `window outside 10-day retention` in Gaps.

## Reading the answers

- Signature "new in window" = first_seen ≥ {from} and Q5/previous-window count is 0.
- "Grew" = count in window ≥ 3 × count in the previous window.
- A TimeLimiter / `TimeoutException` / `NoFallbackAvailableException` whose top frame is a Feign proxy names the **upstream** service in the interface name (`CustomAuctionGroupBatchApi` → custom-auction); the code to look at is the upstream service's endpoint, and the local service's timeout config.
- `UpstreamInputValidationException` with a `deal.error.*` / `*.not.available` global error is business validation surfaced as ERROR, not a bug in the REMEX service.
- Ignore `/management/health` and `/management/info` traffic in any request-count statement (ELB and Spring Boot Admin probes).
