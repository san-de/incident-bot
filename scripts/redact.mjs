#!/usr/bin/env node
// Redact secret-shaped strings and personal data from text or JSON.
//   node scripts/redact.mjs < text-or-json        # stdin → stdout
//   node scripts/redact.mjs --file report.json
import fs from "node:fs";
import { parseArgs } from "./lib/cli.mjs";
import { redact, redactDeep } from "./lib/redact.mjs";

const opt = parseArgs(process.argv.slice(2));
const raw = opt.file ? fs.readFileSync(opt.file, "utf8") : fs.readFileSync(0, "utf8");
try {
  process.stdout.write(JSON.stringify(redactDeep(JSON.parse(raw)), null, 2) + "\n");
} catch {
  process.stdout.write(redact(raw));
}
