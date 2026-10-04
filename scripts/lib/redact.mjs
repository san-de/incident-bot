// Strip secret-shaped strings and personal data before anything reaches the model or a Slack post.
// Every script routes its error text through redact(); post.mjs routes the rendered message through it.
const PATTERNS = [
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<aws-key>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<github-token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<github-token>"],
  [/\bxox[bpaors]-[A-Za-z0-9-]{10,}\b/g, "<slack-token>"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "<google-key>"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "<stripe-key>"],
  [/\bcci_production_[A-Za-z0-9]{20,}\b/g, "<agent1-key>"],
  [/\bagent1_[A-Za-z0-9]{20,}\b/g, "<agent1-key>"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "<anthropic-key>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key>"],
  [/\b(ApiKey|Bearer)\s+[A-Za-z0-9+/=_-]{16,}/g, "$1 <redacted>"],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"'&]{6,}/gi, "$1=<redacted>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
  [/\b[A-HJ-NPR-Z0-9]{17}\b/g, m => m.slice(0, 5) + "…" + m.slice(-3)],   // VIN: keep ends, drop the middle
];

export function redact(text) {
  let t = String(text ?? "");
  for (const [re, rep] of PATTERNS) t = t.replace(re, rep);
  return t;
}

export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}
