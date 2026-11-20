/**
 * Secret filtering for prompt text (design §11). Applied to everything taken from source code before
 * it is sent to a provider. It never changes source files or hashes.
 */

export const REDACTED = "<redacted>";

/** Known secret formats. Each matches the secret itself, wherever it appears. */
const KNOWN: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI style keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe keys
];

/** String literal contents: '...', "...", `...` without interpolation. */
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n$])*)\1/g;

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  let out = text;
  for (const pattern of KNOWN) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  out = out.replace(STRING_LITERAL, (whole, quote: string, body: string) => {
    if (!looksLikeSecret(body)) return whole;
    count++;
    return `${quote}${REDACTED}${quote}`;
  });
  return { text: out, count };
}

/**
 * High-entropy strings of length ≥ 20 with no spaces: random-looking tokens. Paths, URLs, and
 * sentences have spaces, low entropy, or separators and are left alone.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 20 || /\s/.test(value) || value === REDACTED) return false;
  if (/^[a-z]+:\/\//i.test(value) || /^[./~]/.test(value) || value.includes("/")) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(value)).length;
  return classes >= 2 && entropy(value) >= 4;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
