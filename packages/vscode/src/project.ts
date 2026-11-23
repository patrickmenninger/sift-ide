import type { FileExtraction, SourcePosition, SourceRange, StatusReport } from "@sift/core";
import { ServerProcess, type ServerChild } from "./server-process.js";
import { filesWithProblems, statusEntries, type FileProblems, type StatusEntry } from "./status-model.js";

/**
 * One Sift project (a folder with sift.config.yaml) and its server. Holds the last status report
 * and refreshes it, coalescing bursts of file events. No `vscode` here, so it can be tested
 * against a real server in-process.
 */
export class Project {
  readonly server: ServerProcess;
  private statusValue: (StatusReport & { inSync: boolean }) | null = null;
  private entriesValue: StatusEntry[] = [];
  private filesValue = new Map<string, FileProblems>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly listeners = new Set<() => void>();

  private readonly debounceMs: number;

  constructor(
    readonly root: string,
    options: { launch: () => ServerChild; log: (line: string) => void; debounceMs?: number },
  ) {
    this.debounceMs = options.debounceMs ?? 400;
    this.server = new ServerProcess({ root, launch: options.launch, log: options.log });
    // Descriptions written by someone else (generate in a terminal, git) change the status.
    this.server.on("sift/didChange", (change) => {
      if (change.type === "descriptions") this.scheduleRefresh();
    });
  }

  get status(): (StatusReport & { inSync: boolean }) | null {
    return this.statusValue;
  }

  get entries(): StatusEntry[] {
    return this.entriesValue;
  }

  /** Source files (project-relative) whose logic is out of date or missing. */
  get files(): Map<string, FileProblems> {
    return this.filesValue;
  }

  /** Units whose description is out of date or missing. */
  get outOfDate(): number {
    return this.entriesValue.length;
  }

  onDidChangeStatus(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Refresh soon; several calls within the debounce window make one request. */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshStatus().catch(() => {});
    }, this.debounceMs);
  }

  /** Ask the server for the status now. Overlapping calls run one more time, not once each. */
  refreshStatus(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const status = await this.server.request("sift/status", {});
          this.statusValue = status;
          this.entriesValue = statusEntries(status);
          this.filesValue = filesWithProblems(this.entriesValue);
          for (const l of this.listeners) l();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Project-relative path of an absolute path inside the project, or null if outside. */
  relative(absolute: string): string | null {
    const root = normalise(this.root);
    const path = normalise(absolute);
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!sameStart(path, prefix)) return null;
    return path.slice(prefix.length);
  }

  /** The innermost unit at a position, from the file's extraction: works for undescribed units too. */
  async unitAt(source: string, position: SourcePosition): Promise<{ ref: string; range: SourceRange } | null> {
    const extraction = await this.server.request("sift/extraction", { source });
    return innermostUnit(extraction, position);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
    this.server.dispose();
  }
}

export function innermostUnit(extraction: FileExtraction, position: SourcePosition): { ref: string; range: SourceRange } | null {
  let best: { ref: string; range: SourceRange; size: number } | null = null;
  for (const u of extraction.units) {
    if (u.kind === "module" || !contains(u.range, position)) continue;
    const size = (u.range.end.line - u.range.start.line) * 10_000 + (u.range.end.col - u.range.start.col);
    if (!best || size < best.size) best = { ref: `${extraction.path}#${u.symbol}`, range: u.range, size };
  }
  if (best) return { ref: best.ref, range: best.range };
  const module = extraction.units.find((u) => u.kind === "module");
  return module ? { ref: `${extraction.path}#${module.symbol}`, range: module.range } : null;
}

function contains(range: SourceRange, p: SourcePosition): boolean {
  const after = p.line > range.start.line || (p.line === range.start.line && p.col >= range.start.col);
  const before = p.line < range.end.line || (p.line === range.end.line && p.col <= range.end.col);
  return after && before;
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Paths compare case-insensitively on Windows, where drive letters come in either case. */
function sameStart(path: string, prefix: string): boolean {
  return process.platform === "win32" ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
}
