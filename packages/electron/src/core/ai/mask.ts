/**
 * Takes secrets out of text before it leaves this computer for an AI provider (and before
 * it is kept in `ai.sqlite`). Pattern-based, so it is a safety net, not a guarantee: it
 * knows the usual key and token shapes and `NAME=value` lines whose name says secret, plus
 * any exact values the caller knows about (the host's stored password).
 */

export const REDACTED = '[REDACTED]';

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** Well-known token shapes: GitHub, OpenAI/Anthropic-style `sk-`, AWS access keys,
 *  Slack, JWTs. */
const TOKENS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

/** `DB_PASSWORD=…`, `"api_key": "…"`, `token: …` — the name stays, the value goes. Bare
 *  `PWD` is the working directory, not a password, so it is not on the list. */
const ASSIGNMENT =
  /(["']?\b[A-Za-z0-9_.-]*(?:passw(?:or)?d|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?)(\s*[:=]\s*)(["']?)([^\s"',;]+)\3/gi;

/** `scheme://user:password@host` */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi;

export function maskSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    // Short values would blank out ordinary words.
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(PRIVATE_KEY, `${REDACTED} (private key)`);
  for (const pattern of TOKENS) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(ASSIGNMENT, (_m, name: string, sep: string, quote: string, value: string) =>
    value === REDACTED ? `${name}${sep}${quote}${value}${quote}` : `${name}${sep}${quote}${REDACTED}${quote}`
  );
  return out;
}
