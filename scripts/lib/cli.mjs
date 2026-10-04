// Tiny shared CLI helpers. Every script prints JSON on stdout, one-line reasons on stderr, and uses these exit codes:
//   0 ok · 1 runtime error · 2 usage / config · 3 state missing · 4 auth · 5 not found · 6 guard refused
import fs from "node:fs";

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, STATE: 3, AUTH: 4, NOT_FOUND: 5, GUARD: 6 };

/** Parse `--flag value`, `--switch` and positionals. Switches must be listed in `bools`. */
export function parseArgs(argv, bools = []) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (bools.includes(k)) opt[k] = true;
      else opt[k] = argv[++i];
    } else opt._.push(a);
  }
  return opt;
}

export function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }

export function fail(prefix, message, code = EXIT.ERROR) {
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exit(code);
}

export function readInput(file) {
  return JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
}

export function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
export function nowTs() { return (Date.now() / 1000).toFixed(6); }
