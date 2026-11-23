import type { StatusReport } from "@sift/core";

/** Why a unit's description is out of date, in the order the Sift view lists them. */
export type OutOfDateKind = "stale" | "changed" | "new" | "renamed" | "ambiguous" | "contextChanged" | "deleted" | "unreadable";

export const KIND_ORDER: OutOfDateKind[] = ["stale", "changed", "new", "renamed", "ambiguous", "contextChanged", "deleted", "unreadable"];

export const KIND_LABELS: Record<OutOfDateKind, { group: string; one: string }> = {
  stale: { group: "Marked stale (review)", one: "stale" },
  changed: { group: "Code changed", one: "changed" },
  new: { group: "Not described yet", one: "new" },
  renamed: { group: "Renamed or moved", one: "renamed" },
  ambiguous: { group: "Renamed? (unsure)", one: "ambiguous" },
  contextChanged: { group: "Callees' summaries changed", one: "callees changed" },
  deleted: { group: "Code removed", one: "deleted" },
  unreadable: { group: ".sift files that cannot be read", one: "unreadable" },
};

export interface StatusEntry {
  kind: OutOfDateKind;
  /** "file#Symbol", or for `unreadable` the source file. */
  unit: string;
  /** Project-relative source file the entry belongs to. */
  file: string;
  /** Extra text: where a unit was renamed from, or the candidates of an ambiguous rename. */
  detail?: string;
}

export function fileOf(ref: string): string {
  const hash = ref.indexOf("#");
  return hash < 0 ? ref : ref.slice(0, hash);
}

export function symbolOf(ref: string): string {
  const hash = ref.indexOf("#");
  return hash < 0 ? ref : ref.slice(hash + 1);
}

/** Every out-of-date unit in a status report, grouped by kind in `KIND_ORDER`. */
export function statusEntries(report: StatusReport): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const add = (kind: OutOfDateKind, unit: string, detail?: string) => entries.push({ kind, unit, file: fileOf(unit), ...(detail !== undefined ? { detail } : {}) });
  for (const kind of KIND_ORDER) {
    switch (kind) {
      case "stale":
      case "changed":
      case "new":
      case "contextChanged":
      case "deleted":
        for (const u of report[kind]) add(kind, u);
        break;
      case "renamed":
        for (const r of report.renamed) add(kind, r.to, `from ${r.from}`);
        break;
      case "ambiguous":
        for (const a of report.ambiguous) add(kind, a.previous, `could be ${a.candidates.join(", ")}`);
        break;
      case "unreadable":
        for (const f of report.unreadable) add(kind, f);
        break;
    }
  }
  return entries;
}

export interface FileProblems {
  file: string;
  counts: Partial<Record<OutOfDateKind, number>>;
  total: number;
}

/**
 * Source files whose logic is out of date or missing, for explorer decorations. Units whose
 * code is gone are left out: their file may not exist any more.
 */
export function filesWithProblems(entries: StatusEntry[]): Map<string, FileProblems> {
  const files = new Map<string, FileProblems>();
  for (const e of entries) {
    if (e.kind === "deleted") continue;
    let f = files.get(e.file);
    if (!f) files.set(e.file, (f = { file: e.file, counts: {}, total: 0 }));
    f.counts[e.kind] = (f.counts[e.kind] ?? 0) + 1;
    f.total++;
  }
  return files;
}

/** "2 changed, 1 new" */
export function describeCounts(counts: Partial<Record<OutOfDateKind, number>>): string {
  return KIND_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${KIND_LABELS[k].one}`).join(", ");
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export type StatusBarState =
  | { kind: "starting" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; outOfDate: number; units: number; verified: number }
  | { kind: "busy"; text: string };

/** Status bar text and tooltip. `$(…)` are codicons. */
export function statusBarContent(state: StatusBarState): { text: string; tooltip: string; warning: boolean } {
  switch (state.kind) {
    case "starting":
      return { text: "$(loading~spin) Sift", tooltip: "Sift is starting", warning: false };
    case "failed":
      return { text: "$(error) Sift", tooltip: `Sift is not running: ${state.message}\nClick to see the output.`, warning: true };
    case "busy":
      return { text: `$(loading~spin) Sift: ${state.text}`, tooltip: state.text, warning: false };
    case "ready":
      if (state.outOfDate === 0) {
        return { text: "$(check) Sift", tooltip: `Every description matches the code (${plural(state.units, "unit")}, ${state.verified} verified).`, warning: false };
      }
      return {
        text: `$(warning) Sift: ${state.outOfDate}`,
        tooltip: `${plural(state.outOfDate, "description")} out of date or missing. Click to list them.`,
        warning: true,
      };
  }
}
