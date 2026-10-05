#!/usr/bin/env node
// Chunk 2 helper: turn any Kibana link shape into { service, from, to, errorId, traceId, levels, kql, filters }.
// Merges the former kibana-url.js (Discover URL, rison), lz-decode.js (locator links) and kibana-shorturl.js (/app/r/s/<id>).
//
//   node scripts/links.mjs discover '<discover url>' [anchor-iso]      # rison parse, no network
//   node scripts/links.mjs lz '<locator url or lz value>'              # lz-string decode, no network
//   node scripts/links.mjs short '<short url or slug>' [--env prod]    # Kibana short-URL API (/app/r/s/<id> or /goto/<id>), read-only, key never printed
//   node scripts/links.mjs resolve '<any kibana url>' [anchor-iso] [--env prod]   # picks the shape, follows short → discover
//
// Exit codes: 0 ok · 1 undecodable · 2 no key / usage · 3 unreachable · 4 auth · 5 unknown slug.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, out, fail, EXIT } from "./lib/cli.mjs";
import { resolveElasticKey, kibanaBaseUrl } from "./lib/elastic-key.mjs";

export function unslack(s) {
  s = String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const m = s.match(/<(https?:[^|>]+)(?:\|[^>]*)?>/);
  if (m) s = m[1];
  return s.trim();
}

// ---------- rison ----------
export function rison(str) {
  let i = 0;
  const idChar = c => /[A-Za-z0-9_\-./~]/.test(c);
  function ws() { while (i < str.length && str[i] === " ") i++; }
  function value() {
    ws();
    const c = str[i];
    if (c === "(") return obj();
    if (c === "!") {
      i++;
      const n = str[i++];
      if (n === "(") return arr();
      if (n === "t") return true;
      if (n === "f") return false;
      if (n === "n") return null;
      throw new Error("bad !" + n);
    }
    if (c === "'") return qstr();
    if (c === "-" || /[0-9]/.test(c)) {
      let j = i;
      while (j < str.length && /[0-9.\-eE+]/.test(str[j])) j++;
      const t = str.slice(i, j); i = j; return Number(t);
    }
    let j = i;
    while (j < str.length && idChar(str[j])) j++;
    if (j === i) throw new Error("unexpected " + c + " at " + i);
    const t = str.slice(i, j); i = j; return t;
  }
  function qstr() {
    i++;
    let o = "";
    while (i < str.length) {
      const c = str[i++];
      if (c === "!") { o += str[i++]; continue; }
      if (c === "'") return o;
      o += c;
    }
    return o;
  }
  function obj() {
    i++;
    const o = {};
    ws();
    if (str[i] === ")") { i++; return o; }
    while (i < str.length) {
      const k = value();
      ws();
      if (str[i] !== ":") throw new Error("expected : at " + i);
      i++;
      o[k] = value();
      ws();
      if (str[i] === ",") { i++; continue; }
      if (str[i] === ")") { i++; return o; }
      throw new Error("expected , or ) at " + i);
    }
    return o;
  }
  function arr() {
    const a = [];
    ws();
    if (str[i] === ")") { i++; return a; }
    while (i < str.length) {
      a.push(value());
      ws();
      if (str[i] === ",") { i++; continue; }
      if (str[i] === ")") { i++; return a; }
      throw new Error("expected , or ) in array at " + i);
    }
    return a;
  }
  return value();
}

// ---------- time ----------
function shift(d, sign, n, unit) {
  const ms = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit] * Number(n);
  return new Date(d.getTime() + (sign === "-" ? -ms : ms));
}
export function absTime(t, anchor) {
  if (typeof t !== "string") return null;
  const m = t.match(/^(.*?)\|\|([+-])(\d+)([smhd])$/);            // '<iso>||-30m'
  if (m) return shift(new Date(m[1]), m[2], m[3], m[4]);
  const r = t.match(/^now(?:([+-])(\d+)([smhd]))?(?:\/[smhd])?$/);  // now-15m
  if (r) return r[1] ? shift(anchor, r[1], r[2], r[3]) : anchor;
  const d = new Date(t.replace(/(\.\d{3})\d+(Z|[+-]\d\d:?\d\d)$/, "$1$2"));   // Kibana writes microseconds
  return isNaN(d) ? null : d;
}

// ---------- discover ----------
export function parseDiscover(raw, anchorIso) {
  const anchor = anchorIso ? new Date(anchorIso) : new Date();
  let url = unslack(raw);
  try { url = decodeURIComponent(url); } catch { /* keep */ }
  const frag = url.includes("#") ? url.slice(url.indexOf("#")) : url;
  const params = {};
  for (const part of frag.replace(/^#\/?(?:discover)?\??/, "").split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const g = params._g ? rison(params._g) : {};
  const a = params._a ? rison(params._a) : {};
  const res = { shape: "discover", service: null, from: null, to: null, errorId: null, traceId: null, levels: [], kql: "", filters: [] };
  if (g.time) {
    const to = absTime(g.time.to, anchor);
    const from = absTime(g.time.from, to || anchor);
    res.from = from && from.toISOString();
    res.to = to && to.toISOString();
  }
  for (const f of a.filters || []) {
    const meta = f.meta || {};
    if (meta.disabled === true) continue;
    let val = meta.params && meta.params.query !== undefined ? meta.params.query
            : Array.isArray(meta.params) ? meta.params
            : meta.value;
    if (val === undefined && f.query) {
      const mp = f.query.match_phrase
        || (f.query.match ? Object.fromEntries(Object.entries(f.query.match).map(([k, v]) => [k, v && v.query !== undefined ? v.query : v])) : null);
      if (mp) val = Object.values(mp)[0];
    }
    const field = meta.key;
    res.filters.push({ field, value: val, negate: !!meta.negate });
    if (meta.negate) continue;
    if (field === "service.name") res.service = String(val);
    if (field === "error.id") res.errorId = String(val);
    if (field === "trace.id") res.traceId = String(val);
    if (field === "log.level") res.levels = Array.isArray(val) ? val.map(String) : [String(val)];
  }
  if (a.query && a.query.query) res.kql = String(a.query.query);
  return res;
}

// ---------- lz-string (compressToBase64 / compressToEncodedURIComponent) ----------
const KEY_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const KEY_URI = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
function decompress(input, keyStr) {
  const dict = {}; for (let i = 0; i < keyStr.length; i++) dict[keyStr[i]] = i;
  const getNext = i => dict[input.charAt(i)];
  const readBits = (data, n) => {
    let bits = 0, power = 1, max = Math.pow(2, n);
    while (power !== max) {
      const resb = data.val & data.position; data.position >>= 1;
      if (data.position === 0) { data.position = 32; data.val = getNext(data.index++); }
      bits |= (resb > 0 ? 1 : 0) * power; power <<= 1;
    }
    return bits;
  };
  const len = input.length; const d = [0, 1, 2]; let enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", result = [], w, c;
  const data = { val: getNext(0), position: 32, index: 1 };
  switch (readBits(data, 2)) {
    case 0: c = String.fromCharCode(readBits(data, 8)); break;
    case 1: c = String.fromCharCode(readBits(data, 16)); break;
    case 2: return "";
  }
  d[3] = c; w = c; result.push(c);
  for (;;) {
    if (data.index > len) return "";
    c = readBits(data, numBits);
    switch (c) {
      case 0: d[dictSize++] = String.fromCharCode(readBits(data, 8)); c = dictSize - 1; enlargeIn--; break;
      case 1: d[dictSize++] = String.fromCharCode(readBits(data, 16)); c = dictSize - 1; enlargeIn--; break;
      case 2: return result.join("");
    }
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
    if (d[c]) entry = d[c]; else if (c === dictSize) entry = w + w.charAt(0); else return null;
    result.push(entry); d[dictSize++] = w + entry.charAt(0); enlargeIn--; w = entry;
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  }
}
export function decodeLz(rawArg) {
  let arg = String(rawArg || "").replace(/&amp;/g, "&");
  const m = arg.match(/(?:^|[?&])lz=([^&|>\s]+)/); if (m) arg = m[1];
  try { arg = decodeURIComponent(arg); } catch { /* keep */ }
  arg = arg.replace(/ /g, "+").replace(/\.\.\.$|…$/, "");
  const text = decompress(arg, /[\/=]/.test(arg) ? KEY_B64 : KEY_URI);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
/** Map a DISCOVER_APP_LOCATOR state to the same shape parseDiscover returns. */
export function fromLocatorState(state, anchorIso) {
  const anchor = anchorIso ? new Date(anchorIso) : new Date();
  const res = { shape: "locator", service: null, from: null, to: null, errorId: null, traceId: null, levels: [], kql: "", filters: [] };
  if (state && state.timeRange) {
    const to = absTime(state.timeRange.to, anchor); const from = absTime(state.timeRange.from, to || anchor);
    res.from = from && from.toISOString(); res.to = to && to.toISOString();
  }
  for (const f of (state && state.filters) || []) {
    const meta = f.meta || {}; if (meta.disabled) continue;
    const val = meta.params && meta.params.query !== undefined ? meta.params.query : (f.query && f.query.match_phrase ? Object.values(f.query.match_phrase)[0] : meta.value);
    res.filters.push({ field: meta.key, value: val, negate: !!meta.negate });
    if (meta.negate) continue;
    if (meta.key === "service.name") res.service = String(val);
    if (meta.key === "error.id") res.errorId = String(val);
    if (meta.key === "trace.id") res.traceId = String(val);
  }
  if (state && state.query && state.query.query) res.kql = String(state.query.query);
  return res;
}

// ---------- short url ----------
export async function resolveShort(target, env = "prod") {
  const clean = String(target).replace(/&amp;/g, "&").replace(/^<|>$/g, "").split("|")[0];
  const m = clean.match(/\/app\/r\/s\/([A-Za-z0-9_-]+)/) || clean.match(/\/goto\/([A-Za-z0-9_-]+)/) || clean.match(/^([A-Za-z0-9_-]{3,})$/);
  if (!m) return { error: "not a short link", code: EXIT.USAGE };
  const id = m[1];
  const key = resolveElasticKey(env);
  if (!key.key) return { error: key.reason, code: EXIT.USAGE };
  const base = kibanaBaseUrl(env);
  let res;
  try {
    res = await fetch(new URL(`/api/short_url/${id}`, base), { headers: { Authorization: `ApiKey ${key.key}`, "kbn-xsrf": "true" }, signal: AbortSignal.timeout(15000) });
  } catch (e) { return { error: `${e.name === "TimeoutError" ? "timeout" : e.message} (VPN?)`, code: 3 }; }
  if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} (auth)`, code: EXIT.AUTH };
  if (res.status === 404) return { error: `HTTP 404 — slug ${id} unknown or expired`, code: EXIT.NOT_FOUND };
  if (res.status !== 200) return { error: `HTTP ${res.status}`, code: EXIT.ERROR };
  const j = await res.json();
  const locator = j.locator || {};
  const o = { shape: "short", id, resolvedUrl: `${base}/app/r/s/${id}`, locatorId: locator.id, state: locator.state || null };
  if (locator.id === "LEGACY_SHORT_URL_LOCATOR" && locator.state && locator.state.url) {
    o.embeddedUrl = /^https?:/.test(locator.state.url) ? locator.state.url : base + locator.state.url;
  }
  return o;
}

/** Any Kibana link → window/filters. Network only for short links. */
export async function resolveAny(raw, anchorIso, env = "prod") {
  const url = unslack(raw);
  if (/\/app\/r\/s\/|\/goto\//.test(url)) {
    const s = await resolveShort(url, env);
    if (s.error) return { shape: "short", error: s.error, code: s.code };
    if (s.embeddedUrl) return Object.assign(parseDiscover(s.embeddedUrl, anchorIso), { via: "short", resolvedUrl: s.resolvedUrl });
    if (s.locatorId === "DISCOVER_APP_LOCATOR") return Object.assign(fromLocatorState(s.state, anchorIso), { via: "short", resolvedUrl: s.resolvedUrl });
    return { shape: "short", error: `unsupported locator ${s.locatorId}`, code: EXIT.ERROR };
  }
  if (/[?&]lz=/.test(url)) {
    const st = decodeLz(url);
    if (!st) return { shape: "locator", error: "lz payload undecodable (truncated?)", code: EXIT.ERROR };
    return fromLocatorState(st, anchorIso);
  }
  if (/discover/.test(url)) return parseDiscover(url, anchorIso);
  return { shape: "unknown", error: "not a Discover, locator or short link", code: EXIT.USAGE };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const [cmd, target, anchor] = opt._;
  const env = (opt.env || "prod").toLowerCase();
  if (!cmd || !target) fail("links", "usage: links.mjs discover|lz|short|resolve '<url>' [anchor-iso] [--env prod]", EXIT.USAGE);
  try {
    if (cmd === "discover") return out(parseDiscover(target, anchor));
    if (cmd === "lz") { const r = decodeLz(target); if (!r) fail("links", "lz payload undecodable (truncated?)", EXIT.ERROR); return out(r); }
    if (cmd === "short") { const r = await resolveShort(target, env); if (r.error) fail("links", r.error, r.code); return out(r); }
    if (cmd === "resolve") { const r = await resolveAny(target, anchor, env); if (r.error) fail("links", r.error, r.code); return out(r); }
    fail("links", `unknown command ${cmd}`, EXIT.USAGE);
  } catch (e) { fail("links", e.message, EXIT.ERROR); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
