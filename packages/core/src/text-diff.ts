/**
 * Small text comparisons for sync: token similarity for rename detection (design §7.2) and a line
 * diff of a unit's old and new source for the update prompt (§7.4).
 */

/** Code tokens, without comments and whitespace: identifiers, numbers, strings, and punctuation. */
export function tokenize(code: string): string[] {
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  return withoutComments.match(/[A-Za-z_$][\w$]*|\d[\w.]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s\w]/g) ?? [];
}

/**
 * Similarity of two token lists between 0 and 1: twice the longest common subsequence over the
 * total length. Very long lists fall back to comparing token counts, which ignores order.
 */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 4_000_000) return bagSimilarity(a, b);
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

function bagSimilarity(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) (common++, counts.set(t, n - 1));
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * The whole of `after`, line by line, with removed lines of `before` interleaved: each line starts
 * with "  " (unchanged), "- " (removed), or "+ " (added). Units are short, so the full text is
 * clearer than hunks.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const key = (l: string) => l.trim();
  // LCS table over trimmed lines, so re-indentation alone does not show as a change.
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i]![j] = key(a[i]!) === key(b[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && key(a[i]!) === key(b[j]!)) out.push(`  ${b[j++]}`), i++;
    else if (j < m && (i >= n || table[i]![j + 1]! > table[i + 1]![j]!)) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join("\n");
}
