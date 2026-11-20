import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const ID_PATTERNS = {
  unit: /^u_[a-z2-7]{8}$/,
  step: /^s_[a-z2-7]{4}$/,
  warning: /^w_[a-z2-7]{4}$/,
} as const;

const SPEC = { unit: ["u_", 8], step: ["s_", 4], warning: ["w_", 4] } as const;

/**
 * A new opaque ID (design §6.2) that is not in `taken`. IDs never encode names or positions,
 * so renaming or moving code keeps them stable.
 */
export function newId(kind: keyof typeof SPEC, taken: ReadonlySet<string> = new Set()): string {
  const [prefix, length] = SPEC[kind];
  for (;;) {
    const bytes = randomBytes(length);
    let id = prefix;
    for (const b of bytes) id += ALPHABET[b % 32];
    if (!taken.has(id)) return id;
  }
}
