#!/usr/bin/env node
// Chunk 3, deterministic half: read-only log lookup through Kibana's internal search endpoint. (Was kibana-search.js.)
// The Kibana App-Debugging agent only sees exceptions with error.type set; this sees every line, with real counts.
//
//   node scripts/kibana.mjs hits      --service new-margin --from ISO --to ISO [--error-id x | --trace-id y | --text "NPE"] [--levels ERROR,WARN] [--size 5]
//   node scripts/kibana.mjs count     --service new-margin --from ISO --to ISO [--text …]
//   node scripts/kibana.mjs histogram --service new-margin --from ISO --to ISO [--interval 5m]
//   node scripts/kibana.mjs deploy    --service new-margin --to ISO [--lookback-hours 48]   # newest startup line = deploy anchor
//   node scripts/kibana.mjs key-check [--env prod]                                          # prints source env|file|none, exit 0/2
//
// Key: ELASTIC_API_KEY_<ENV> from the environment, else the kibana plugin's keys file (ELASTIC_API_KEY_FILE or
// ~/.config/auto1-kibana/keys.json) — never printed. Optional KIBANA_URL (default prod).
// Index: default "*logs-auto1.services*"; pass --index "*beat-*" or "*" to widen. Output carries partial:true + warning
// when ES timed out or shards failed — treat total 0 with partial:true as "unknown", not "none".
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { resolveElasticKey, kibanaBaseUrl, describe } from "./lib/elastic-key.mjs";
import { redact } from "./lib/redact.mjs";

const APP_FRAME = /\b(wkda|com\.auto1)\./;
const STARTUP = /Started [A-Za-z0-9]+Application in|Tomcat started on port|Netty started on port/;

export function buildQuery(opt) {
  const filter = [];
  if (opt.service) filter.push({ match: { "service.name": opt.service } });
  if (opt.errorId) filter.push({ match: { "error.id": opt.errorId } });
  if (opt.traceId) filter.push({ match: { "trace.id": opt.traceId } });
  if (opt.levels) filter.push({ terms: { "log.level": opt.levels } });
  if (opt.text) filter.push({ query_string: { query: `"${String(opt.text).replace(/"/g, '\\"')}"`, fields: ["message", "error.stack_trace", "error.type"] } });
  filter.push({ range: { "@timestamp": { gte: opt.from || `now-${opt.days || 10}d`, lte: opt.to || "now" } } });
  return { bool: { filter } };
}

function shapeHit(h) {
  const s = h._source || {}; const st = String(((s.error || {}).stack_trace) || ""); const lines = st.split("\n");
  return {
    ts: s["@timestamp"], level: (s.log || {}).level, logger: (s.log || {}).logger, service: (s.service || {}).name,
    traceId: (s.trace || {}).id, errorId: (s.error || {}).id, errorType: (s.error || {}).type,
    path: (s.url || {}).path, message: redact(String(s.message || "").slice(0, 300)),
    exception: lines[0] ? redact(lines[0].slice(0, 300)) : null,
    appFrames: lines.filter(l => APP_FRAME.test(l)).slice(0, 6).map(l => l.trim()),
    causes: lines.filter(l => /^\s*(Caused by|Wrapped by)/.test(l)).slice(0, 5).map(l => redact(l.trim().slice(0, 200))),
    threadHints: lines.filter(l => /(ThreadPoolExecutor|ForkJoin|SqsListener|Scheduled|ContextPropagator|FutureTask|TaskExecutor)/.test(l)).slice(0, 3).map(l => l.trim().slice(0, 120)),
    index: h._index,
  };
}

export async function search(env, index, body) {
  const key = resolveElasticKey(env);
  if (!key.key) return { error: key.reason, code: EXIT.USAGE };
  const base = kibanaBaseUrl(env);
  let res;
  try {
    res = await fetch(new URL("/internal/search/es", base), {
      method: "POST", signal: AbortSignal.timeout(60000),
      headers: { Authorization: `ApiKey ${key.key}`, "kbn-xsrf": "true", "x-elastic-internal-origin": "Kibana", "elastic-api-version": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ params: { index, ignore_unavailable: true, body } }),
    });
  } catch (e) { return { error: e.name === "TimeoutError" ? "timeout" : redact(e.message), code: 3 }; }
  if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} (auth)`, code: EXIT.AUTH };
  if (res.status !== 200) return { error: `HTTP ${res.status} ${redact((await res.text()).slice(0, 300))}`, code: EXIT.ERROR };
  const r = (await res.json()).rawResponse || {};
  const shards = r._shards || {};
  const partial = Boolean(r.timed_out) || (shards.failed || 0) > 0;
  return { raw: r, partial, warning: partial ? `partial result (timed_out=${!!r.timed_out}, failed shards=${shards.failed || 0}/${shards.total || "?"}) — retry with a narrower index or window` : undefined };
}

function totalOf(r) { const t = r.hits && r.hits.total; return t ? (t.value !== undefined ? t.value : t) : 0; }

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0];
  const env = (opt.env || "prod").toLowerCase();
  if (cmd === "key-check") { const k = resolveElasticKey(env); out(describe(k)); process.exit(k.key ? 0 : EXIT.USAGE); }
  const q = { service: opt.service, errorId: opt["error-id"], traceId: opt["trace-id"], text: opt.text, from: opt.from, to: opt.to, days: opt.days ? Number(opt.days) : undefined, levels: opt.levels ? opt.levels.split(",") : null };
  const index = opt.index || "*logs-auto1.services*";
  if (!["hits", "count", "histogram", "deploy"].includes(cmd)) fail("kibana", "usage: kibana.mjs hits|count|histogram|deploy|key-check …", EXIT.USAGE);
  if (cmd !== "deploy" && !q.service && !q.errorId && !q.traceId && !q.text) fail("kibana", "give at least one of --service --error-id --trace-id --text", EXIT.USAGE);

  let body;
  if (cmd === "hits") body = { size: Number(opt.size || 5), query: buildQuery(q), sort: [{ "@timestamp": "desc" }],
    _source: ["@timestamp", "log.level", "log.logger", "message", "error.id", "error.type", "error.stack_trace", "trace.id", "service.name", "url.path", "http.request.method"],
    aggs: { per_day: { date_histogram: { field: "@timestamp", calendar_interval: "day", min_doc_count: 1 } }, services: { terms: { field: "service.name", size: 10 } }, traces: { cardinality: { field: "trace.id" } } } };
  if (cmd === "count") body = { size: 0, query: buildQuery(q), track_total_hits: true, aggs: { levels: { terms: { field: "log.level", size: 6 } }, traces: { cardinality: { field: "trace.id" } } } };
  if (cmd === "histogram") body = { size: 0, query: buildQuery(q), aggs: { buckets: { date_histogram: { field: "@timestamp", fixed_interval: opt.interval || "5m", min_doc_count: 0, extended_bounds: q.from && q.to ? { min: q.from, max: q.to } : undefined }, aggs: { levels: { terms: { field: "log.level", size: 6 } } } } } };
  if (cmd === "deploy") {
    if (!q.service) fail("kibana", "deploy needs --service", EXIT.USAGE);
    const to = q.to || new Date().toISOString();
    const from = new Date(new Date(to).getTime() - Number(opt["lookback-hours"] || 48) * 3600e3).toISOString();
    body = { size: 3, query: buildQuery({ service: q.service, from, to, text: null }), sort: [{ "@timestamp": "desc" }], _source: ["@timestamp", "message", "service.version", "service.name"] };
    body.query.bool.filter.push({ query_string: { query: "\"Started\" AND (\"Application in\" OR \"started on port\")", fields: ["message"] } });
  }

  const r = await search(env, index, body);
  if (r.error) fail("kibana", r.error, r.code);
  const raw = r.raw, aggs = raw.aggregations || {};
  const base = { mode: cmd, partial: r.partial, warning: r.warning, window: { from: q.from || null, to: q.to || null }, index };
  if (cmd === "hits") return out(Object.assign(base, { total: totalOf(raw), distinctTraces: aggs.traces && aggs.traces.value,
    perDay: ((aggs.per_day || {}).buckets || []).map(b => [b.key_as_string.slice(0, 10), b.doc_count]),
    services: ((aggs.services || {}).buckets || []).map(b => [b.key, b.doc_count]),
    hits: ((raw.hits || {}).hits || []).map(shapeHit) }));
  if (cmd === "count") return out(Object.assign(base, { total: totalOf(raw), distinctTraces: aggs.traces && aggs.traces.value,
    byLevel: Object.fromEntries(((aggs.levels || {}).buckets || []).map(b => [b.key, b.doc_count])) }));
  if (cmd === "histogram") return out(Object.assign(base, { interval: opt.interval || "5m",
    buckets: ((aggs.buckets || {}).buckets || []).map(b => Object.assign({ t: b.key_as_string, total: b.doc_count }, Object.fromEntries(((b.levels || {}).buckets || []).map(l => [l.key, l.doc_count])))) }));
  if (cmd === "deploy") {
    const hits = ((raw.hits || {}).hits || []).map(h => h._source || {}).filter(s => STARTUP.test(String(s.message || "")));
    const newest = hits[0];
    return out(Object.assign(base, { deployAnchor: newest ? newest["@timestamp"] : null, version: newest && newest.service ? newest.service.version || null : null,
      message: newest ? redact(String(newest.message).slice(0, 160)) : null, source: newest ? "startup-log" : "none" }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
