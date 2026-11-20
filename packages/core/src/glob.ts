/**
 * Glob patterns, used for file paths (`include`/`exclude`, separator "/") and for
 * qualified names in rule packs (separator ".").
 *
 * - `*` matches any run of characters within one segment, `?` one character within a segment.
 * - `**` matches any number of whole segments, including none (`src/**`, `**\/*.test.*`).
 * - `{a,b}` matches either alternative; alternatives may contain other glob syntax.
 */
export function globToRegExp(pattern: string, separator = "/"): RegExp {
  const sep = escapeRegExp(separator);
  const notSep = `[^${sep}]`;
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const atStart = i === 0 || pattern[i - 1] === separator;
      const next = pattern[i + 2];
      i++;
      if (atStart && next === separator) {
        out += `(?:.*${sep})?`; // "**/" — zero or more leading segments
        i++;
      } else if (atStart && next === undefined && i > 1) {
        out = out.slice(0, -sep.length) + `(?:${sep}.*)?`; // trailing "/**" — the folder itself or anything in it
      } else out += ".*";
    } else if (c === "*") out += `${notSep}*`;
    else if (c === "?") out += notSep;
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += escapeRegExp(c);
  }
  if (braces > 0) throw new Error(`Unclosed "{" in pattern "${pattern}"`);
  return new RegExp(`^${out}$`);
}

/** True if `text` matches any of the patterns. */
export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
