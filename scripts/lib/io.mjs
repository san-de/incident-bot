import fs from "node:fs";
import path from "node:path";

export function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

export function readJsonIf(p, fallback = null) {
  try { return readJson(p); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}

/** Atomic write: tmp file in the same directory, then rename. */
export function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, p);
}

export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
