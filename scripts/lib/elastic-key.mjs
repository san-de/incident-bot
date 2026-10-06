// Resolve an Elastic/Kibana API key without ever printing it.
// Order mirrors the auto1 kibana plugin: ELASTIC_API_KEY → ELASTIC_API_KEY_<SLOT> → the plugin's keys file
// (ELASTIC_API_KEY_FILE || ~/.config/auto1-kibana/keys.json, a flat JSON object keyed by slot name).
// On Agent1 there are no task-level env vars, so the file is the only source there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SLOTS = {
  prod: "ELASTIC_API_KEY_PROD",
  qa: "ELASTIC_API_KEY_QA",
  "metrics-prod": "ELASTIC_API_KEY_METRICS_PROD",
  "metrics-qa": "ELASTIC_API_KEY_METRICS_QA",
};

export function slotFor(env) {
  const e = String(env || "prod").toLowerCase();
  return SLOTS[e] || `ELASTIC_API_KEY_${e.toUpperCase().replace(/-/g, "_")}`;
}

export function keysFile() {
  return process.env.ELASTIC_API_KEY_FILE || path.join(os.homedir(), ".config", "auto1-kibana", "keys.json");
}

function usable(v) { return typeof v === "string" && v.trim().length > 8 && !/^<.*>$/.test(v.trim()); }

/**
 * @returns {{key: string|null, source: 'env'|'file'|'none', slot: string, file: string, fallback?: string, reason?: string}}
 * The QA slots fall back to the PROD key of the same kind (the PROD Elastic key is accepted by the QA Kibana), so a team
 * watching QA alerts needs no second key. `fallback` names the slot actually used when it differs from the requested one.
 */
export function resolveElasticKey(env) {
  const slot = slotFor(env);
  const file = keysFile();
  const chain = [slot];
  if (/_QA$/.test(slot)) chain.push(slot.replace(/_QA$/, "_PROD"));
  if (usable(process.env.ELASTIC_API_KEY)) return { key: process.env.ELASTIC_API_KEY, source: "env", slot, file };
  for (const s of chain) if (usable(process.env[s])) return { key: process.env[s], source: "env", slot, file, fallback: s !== slot ? s : undefined };
  let json = null, why = null;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { why = e.code === "ENOENT" ? `no keys file at ${file}` : `keys file ${file} unreadable (${e.code || e.name})`; }
  if (json) {
    for (const s of chain) if (usable(json[s])) return { key: json[s], source: "file", slot, file, fallback: s !== slot ? s : undefined };
    return { key: null, source: "none", slot, file, reason: `slot ${chain.join(" / ")} missing in ${file}` };
  }
  return { key: null, source: "none", slot, file, reason: `${chain.join(" / ")} not in env and ${why}` };
}

export function kibanaBaseUrl(env) {
  if (process.env.KIBANA_URL) return process.env.KIBANA_URL;
  return String(env || "prod").toLowerCase() === "qa" ? "https://kibana.qa.services.auto1.team" : "https://kibana.prod.services.auto1.team";
}

/** Safe-to-print view (no key material). */
export function describe(res) {
  return { slot: res.slot, source: res.source, fallback: res.fallback, file: res.source === "file" ? res.file : undefined, reason: res.reason };
}
