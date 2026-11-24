import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterProject, Diagnostic, ExtractedUnit, FileExtraction } from "./adapter.js";
import { SiftCache } from "./cache.js";
import { SIFT_DIR, type SiftConfig } from "./config.js";
import { annotatedSource, flatten, unitText } from "./describe-input.js";
import {
  CODE_SCHEMA,
  MAX_QUESTIONS,
  PLAN_SCHEMA,
  renderCodeInput,
  renderLogicDiff,
  renderPlanInput,
  renderVerifyInput,
  validateCode,
  validatePlan,
  validateVerify,
  VERIFY_SCHEMA,
  type CodeResponse,
  type EditPlan,
  type Neighbour,
  type VerifyResponse,
} from "./edit-prompts.js";
import {
  applyDescriptionEdits,
  applySourceChanges,
  endOfImports,
  logicDiff,
  textHash,
  unifiedDiff,
  type DescriptionEdit,
  type LogicChange,
  type SourceInsertion,
  type SourceReplacement,
} from "./edit-text.js";
import { clearsLite, effectsOfUnit } from "./effects.js";
import { SiftError } from "./errors.js";
import { writeFileAtomic } from "./fs.js";
import { redescribeUnit } from "./generate.js";
import { fileOfId, unitId, type CodeGraph } from "./graph.js";
import { newId } from "./ids.js";
import { loadPrompt } from "./prompts.js";
import { carryProvenance, hasPersonWording, personWording } from "./provenance.js";
import type { CompletionResult, Provider, Task, Tier } from "./provider.js";
import type { Route, Router } from "./routing.js";
import type { RuleSet } from "./rules.js";
import { EFFECTS, requiredSchemaVersion, type Effect, type SiftFile, type SiftStep, type SiftUnit } from "./schema.js";
import { redactSecrets } from "./redact.js";
import { readSiftFile, siftPathFor, writeSiftFile } from "./store.js";
import { validateSiftFile } from "./validate.js";

/**
 * Natural-language editing (phase-2-design §8): a person's edits to a unit's description, or a
 * request in their words, become a reviewed change to the code.
 *
 *   1 snapshot · 2 locate · 3 scope · 4 plan (questions) · 5 code · 6 validate (one retry)
 *   7 re-derive the description, check it against the request · 8 review · 9 apply on approval
 *
 * Steps 1–8 never touch the person's files. Change requests live in `.sift/edits/<id>.json`
 * (git-ignored: a draft is a person's work, so it is not in the cache, which may be deleted).
 */

export const EDITS_DIR = `${SIFT_DIR}/edits`;

export type EditState = "draft" | "planning" | "needs-answers" | "proposing" | "ready" | "needs-review" | "applied" | "rejected" | "failed" | "undone";

export interface EditQuestion {
  id: string;
  text: string;
  options: string[];
}

export interface CheckResult {
  name: string;
  kind: "parse" | "type-check" | "scope" | "effects" | "command";
  status: "passed" | "failed" | "skipped" | "unavailable";
  /** What failed, or why a check did not run. */
  details: string[];
}

export interface EditUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  /** Per task: calls and milliseconds. */
  tasks: Partial<Record<Task, { calls: number; durationMs: number }>>;
}

export interface ProposedUnit {
  /** "file#Symbol" */
  ref: string;
  /** The description before, or null for a unit that had none. */
  before: SiftUnit | null;
  /** The re-derived description written on apply. */
  after: SiftUnit;
  logic: LogicChange[];
}

export interface EditProposal {
  kind: "behavior" | "reword";
  /** New text for each source file that changes, with the hash of the text it was made from. */
  files: {
    path: string;
    /** `textHash` of the text the change was made from. */
    beforeHash: string;
    /** The adapter's file hash of that text and of the new text (as in `.sift` files). */
    beforeFileHash: string;
    afterFileHash: string;
    text: string;
    diff: string;
  }[];
  units: ProposedUnit[];
  /** Units the change adds (new helpers): described on the next generate. */
  newUnits: string[];
  scope: {
    /** Units whose code changes. */
    changed: string[];
    /** Units the plan allowed to change. */
    allowed: string[];
    /** Units and routes that may be affected, through the code graph. */
    affected: { units: string[]; routes: string[] };
    /** Set when the change reaches beyond the edited unit; applying needs a second confirmation. */
    broader: { reason: string; units: string[] } | null;
  };
  checks: CheckResult[];
  effects: { added: Effect[]; removed: Effect[] };
  verify: VerifyResponse | null;
  warnings: { kind: string; text: string }[];
  notes: string;
}

export interface ChangeRequest {
  /** "e_" + 8 base32 characters. */
  id: string;
  unitId: string;
  file: string;
  symbol: string;
  base: { bodyHash: string; fileHash: string; description: SiftUnit };
  edits: DescriptionEdit[];
  request?: string;
  answers: { questionId: string; question: string; answer: string }[];
  /** Open questions, while `needs-answers`. */
  questions?: EditQuestion[];
  /** How many rounds of questions were asked. */
  rounds?: number;
  state: EditState;
  plan?: EditPlan;
  proposal?: EditProposal;
  error?: { message: string; details: string[] };
  /** Why the request needs review (`needs-review`). */
  review?: string;
  usage: EditUsage;
  createdAt: string;
  updatedAt: string;
}

export type EditEvent =
  | { type: "stage"; id: string; stage: "planning" | "coding" | "validating" | "describing" | "verifying"; attempt?: number }
  | { type: "state"; id: string; state: EditState };

/** An applied edit's undo record: what each file it wrote held before, and a hash of what it wrote. */
export interface AppliedRecord {
  id: string;
  appliedAt: string;
  files: { path: string; before: string | null; afterHash: string }[];
}

/** What the workspace gives the edit service. */
export interface EditHost {
  root: string;
  config: SiftConfig;
  rules: RuleSet;
  provider: Provider | undefined;
  router(): Promise<Router>;
  graph(): Promise<CodeGraph>;
  extraction(source: string): Promise<FileExtraction>;
  extractions(sources: string[]): Promise<Map<string, FileExtraction>>;
  unit(query: string): Promise<{ source: string; unit: SiftUnit }>;
  unitIndex(): Promise<Map<string, { source: string; unit: SiftUnit }>>;
  /** The open adapter project for a source file, up to date with the disk. */
  project(source: string): Promise<AdapterProject>;
  hashFile(source: string, text: string): string;
  /** Run a task while no other workspace operation runs (writes). */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  changed(files: string[], kind: "source" | "descriptions" | "edits"): void;
}

const OPEN_STATES: EditState[] = ["draft", "needs-answers", "ready", "failed"];

export class EditService {
  /** Requests whose pipeline is running in this process. */
  private readonly running = new Set<string>();

  constructor(private readonly host: EditHost) {}

  // ---------------------------------------------------------------- drafts

  /**
   * Start a change request for a unit. Its description must be up to date with the code: an edit
   * is written against what the description says, so the description has to say what the code does.
   */
  async create(input: { unit: string; edits?: DescriptionEdit[]; request?: string }): Promise<ChangeRequest> {
    const { source, unit } = await this.host.unit(input.unit);
    const extraction = await this.host.extraction(source);
    const extracted = extraction.units.find((u) => u.symbol === unit.symbol);
    const ref = unitId(source, unit.symbol);
    if (!extracted) throw new SiftError("EDIT_INVALID_STATE", `${ref} is no longer in the code. Run "sift generate ${source}" first.`);
    if (extracted.bodyHash !== unit.bodyHash) throw new SiftError("EDIT_INVALID_STATE", `The description of ${ref} is out of date with its code. Run "sift generate ${source}" first, so the edit starts from what the code does now.`);
    if (unit.status === "stale") throw new SiftError("EDIT_INVALID_STATE", `The description of ${ref} is marked stale. Review it and run "sift generate ${source}" first.`);
    const edits = input.edits ?? [];
    applyDescriptionEdits(unit, edits);
    const now = new Date().toISOString();
    const taken = new Set(await this.ids());
    const req: ChangeRequest = {
      id: newId("edit", taken),
      unitId: unit.id,
      file: source,
      symbol: unit.symbol,
      base: { bodyHash: unit.bodyHash, fileHash: extraction.fileHash, description: unit },
      edits,
      ...(input.request?.trim() ? { request: input.request.trim() } : {}),
      answers: [],
      state: "draft",
      usage: emptyUsage(),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(req);
    return req;
  }

  /** Change a draft's edits or request. A failed or answered request goes back to draft. */
  async update(id: string, change: { edits?: DescriptionEdit[]; request?: string | null }): Promise<ChangeRequest> {
    const req = await this.get(id);
    this.expectState(req, ["draft", "needs-answers", "failed", "ready", "rejected"], "changed");
    if (change.edits) {
      applyDescriptionEdits(req.base.description, change.edits);
      req.edits = change.edits;
    }
    if (change.request === null || change.request?.trim() === "") delete req.request;
    else if (change.request !== undefined) req.request = change.request.trim();
    this.reset(req);
    await this.save(req);
    return req;
  }

  /** Record answers to the open questions. The next `propose` re-plans with them. */
  async answer(id: string, answers: { questionId: string; answer: string }[]): Promise<ChangeRequest> {
    const req = await this.get(id);
    this.expectState(req, ["needs-answers"], "answered");
    const open = req.questions ?? [];
    for (const a of answers) {
      const q = open.find((x) => x.id === a.questionId);
      if (!q) throw new SiftError("EDIT_INVALID_STATE", `${req.id} has no open question ${a.questionId}.`, open.map((x) => `${x.id}: ${x.text}`));
      if (a.answer.trim() === "") throw new SiftError("EDIT_INVALID_STATE", `The answer to ${a.questionId} is empty.`);
      req.answers = req.answers.filter((x) => x.questionId !== q.id || x.question !== q.text);
      req.answers.push({ questionId: q.id, question: q.text, answer: a.answer.trim() });
    }
    const left = open.filter((q) => !answers.some((a) => a.questionId === q.id));
    if (left.length > 0) req.questions = left;
    else {
      delete req.questions;
      req.state = "draft";
    }
    await this.save(req);
    return req;
  }

  /** Discard a request. A draft can be reopened with `update`. */
  async reject(id: string): Promise<ChangeRequest> {
    const req = await this.get(id);
    this.expectState(req, ["draft", "needs-answers", "ready", "failed", "needs-review"], "rejected");
    req.state = "rejected";
    await this.save(req);
    return req;
  }

  /**
   * Start a request that needs review over again from the code as it is now: the base becomes the
   * current description (which must be up to date), and the person's edits are kept where they still fit.
   */
  async rebase(id: string): Promise<ChangeRequest> {
    const req = await this.get(id);
    this.expectState(req, ["needs-review", "rejected", "failed", "draft"], "re-planned");
    const index = await this.host.unitIndex();
    const found = index.get(req.unitId);
    if (!found) throw new SiftError("EDIT_INVALID_STATE", `The unit ${req.symbol} no longer has a description.`);
    const extraction = await this.host.extraction(found.source);
    const extracted = extraction.units.find((u) => u.symbol === found.unit.symbol);
    const ref = unitId(found.source, found.unit.symbol);
    if (!extracted || extracted.bodyHash !== found.unit.bodyHash) throw new SiftError("EDIT_INVALID_STATE", `The description of ${ref} is out of date with its code. Run "sift generate ${found.source}" first.`);
    const kept = req.edits.flatMap((e) => {
      try {
        applyDescriptionEdits(found.unit, [e]);
        return [e];
      } catch {
        return [];
      }
    });
    Object.assign(req, { file: found.source, symbol: found.unit.symbol, edits: kept, base: { bodyHash: found.unit.bodyHash, fileHash: extraction.fileHash, description: found.unit } });
    this.reset(req);
    await this.save(req);
    return req;
  }

  // ---------------------------------------------------------------- reading

  async get(id: string): Promise<ChangeRequest> {
    const req = await this.load(id);
    await this.checkPending([req]);
    return req;
  }

  /** Every change request, newest first, with pending ones checked against the code. */
  async list(options: { states?: EditState[] } = {}): Promise<ChangeRequest[]> {
    const all = await Promise.all((await this.ids()).map((id) => this.load(id)));
    await this.checkPending(all);
    return all.filter((r) => !options.states || options.states.includes(r.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Mark open requests whose code changed underneath them as `needs-review` (phase-2-design §8.9):
   * an edit is never applied to code it was not written against. Returns the IDs that changed.
   */
  async checkPending(requests?: ChangeRequest[]): Promise<string[]> {
    const reqs = requests ?? (await Promise.all((await this.ids()).map((id) => this.load(id))));
    const marked: string[] = [];
    const extractions = new Map<string, FileExtraction | null>();
    for (const req of reqs) {
      if (!OPEN_STATES.includes(req.state) || this.running.has(req.id)) continue;
      // Files that hold exactly the proposed text are being applied by the editor (`sourceWritten`).
      if (req.state === "ready" && req.proposal && req.proposal.files.length > 0 && (await this.holdsProposal(req.proposal))) continue;
      if (!extractions.has(req.file)) extractions.set(req.file, await this.host.extraction(req.file).catch(() => null));
      const now = extractions.get(req.file)?.units.find((u) => u.symbol === req.symbol);
      let reason: string | null = null;
      if (!now) reason = `${req.symbol} is no longer in ${req.file}.`;
      else if (now.bodyHash !== req.base.bodyHash) reason = "The code changed since this edit was written.";
      else if (req.state === "ready" && req.proposal) {
        for (const f of req.proposal.files) {
          const text = await readFile(join(this.host.root, f.path), "utf8").catch(() => null);
          if (text === null || textHash(text) !== f.beforeHash) {
            reason = `${f.path} changed since this change was proposed.`;
            break;
          }
        }
      }
      if (!reason) continue;
      req.state = "needs-review";
      req.review = reason;
      await this.save(req);
      marked.push(req.id);
    }
    if (marked.length > 0) this.host.changed(marked, "edits");
    return marked;
  }

  // ---------------------------------------------------------------- the pipeline

  /**
   * Plan, write, validate, and re-describe the change (steps 1–8). Ends in `needs-answers` (questions
   * to answer, then propose again), `ready` (review it), `needs-review` (the code changed), or
   * `failed` (with the reason). Nothing in the project is changed.
   */
  async propose(id: string, options: { signal?: AbortSignal; onEvent?: (e: EditEvent) => void } = {}): Promise<ChangeRequest> {
    if (this.running.has(id)) throw new SiftError("EDIT_INVALID_STATE", `${id} is already being proposed.`);
    const req = await this.get(id);
    if (req.state === "needs-answers") throw new SiftError("EDIT_INVALID_STATE", `${id} has open questions; answer them first.`, (req.questions ?? []).map((q) => `${q.id}: ${q.text}`));
    this.expectState(req, ["draft", "failed", "ready"], "proposed");
    if (req.edits.length === 0 && !req.request) throw new SiftError("EDIT_INVALID_STATE", `${id} asks for nothing: edit the description or write a request first.`);
    if (!this.host.provider) throw new SiftError("PROVIDER_FAILED", "This workspace was opened without an AI provider, so it cannot propose changes.");
    this.running.add(id);
    const run = new Run(this.host, req, await this.host.router(), options);
    try {
      this.reset(req);
      await run.pipeline();
    } catch (err) {
      if (err instanceof SiftError && (err.code === "CANCELLED" || err.code === "PROVIDER_AUTH")) {
        this.reset(req);
        await this.save(req);
        throw err;
      }
      req.state = "failed";
      req.error = err instanceof SiftError ? { message: err.message, details: err.details } : { message: err instanceof Error ? err.message : String(err), details: [] };
    } finally {
      this.running.delete(id);
    }
    await this.save(req);
    options.onEvent?.({ type: "state", id, state: req.state });
    return req;
  }

  /**
   * Run the configured commands (`edit.checks`) against a copy of the project with the change
   * applied. Only on request: generated code is not executed without the person's consent.
   */
  async runChecks(id: string, options: { signal?: AbortSignal } = {}): Promise<ChangeRequest> {
    const req = await this.get(id);
    this.expectState(req, ["ready"], "checked");
    const proposal = req.proposal!;
    const commands = this.host.config.edit.checks;
    proposal.checks = proposal.checks.filter((c) => c.kind !== "command");
    if (commands.length === 0) {
      proposal.checks.push({ name: "configured commands", kind: "command", status: "unavailable", details: ["No edit.checks are configured in sift.config.yaml."] });
      await this.save(req);
      return req;
    }
    const copy = await copyProject(this.host.root);
    try {
      for (const f of proposal.files) await writeFileAtomic(join(copy, f.path), f.text);
      for (const c of commands) proposal.checks.push(await runCommand(c.name, c.command, copy, this.host.config.edit.checkTimeoutSeconds * 1000, options.signal));
    } finally {
      await rm(join(copy, ".."), { recursive: true, force: true }).catch(() => {});
    }
    await this.save(req);
    return req;
  }

  // ---------------------------------------------------------------- apply and undo

  /**
   * Write the change (step 9), only for a `ready` request. Each file's text is checked against the
   * text the proposal was made from just before writing. `confirmBroader` is required when the
   * change reaches beyond the edited unit. With `sourceWritten`, the client (the editor, through its
   * own undo stack) has already written the source files; they are checked to hold exactly the
   * proposed text, and only the descriptions are written here.
   */
  async apply(id: string, options: { confirmBroader?: boolean; sourceWritten?: boolean } = {}): Promise<{ request: ChangeRequest; written: string[] }> {
    const req = await this.get(id);
    this.expectState(req, ["ready"], "applied");
    const proposal = req.proposal!;
    if (proposal.scope.broader && !options.confirmBroader) {
      throw new SiftError("EDIT_INVALID_STATE", `This change reaches beyond ${req.symbol}: ${proposal.scope.broader.reason} Confirm the broader change to apply it.`, proposal.scope.broader.units);
    }
    const written = await this.host.exclusive(async () => {
      const root = this.host.root;
      const record: AppliedRecord = { id: req.id, appliedAt: new Date().toISOString(), files: [] };
      const texts = new Map<string, string>();
      for (const f of proposal.files) {
        const now = await readFile(join(root, f.path), "utf8").catch(() => null);
        if (options.sourceWritten) {
          if (now !== f.text) throw new SiftError("EDIT_CONFLICT", `${f.path} does not hold the proposed change.`);
          continue;
        }
        if (now === null || textHash(now) !== f.beforeHash) throw new SiftError("EDIT_CONFLICT", `${f.path} changed since this change was proposed; propose it again.`);
        texts.set(f.path, now);
      }

      // The descriptions: each changed unit's re-derived description goes into its file's .sift file.
      const siftFiles = new Map<string, { before: string | null; file: SiftFile }>();
      for (const u of proposal.units) {
        const source = fileOfId(u.ref)!;
        if (!siftFiles.has(source)) {
          const stored = await readSiftFile(root, source);
          if (!stored) throw new SiftError("EDIT_CONFLICT", `${siftPathFor(source)} is gone.`);
          siftFiles.set(source, { before: stored.text, file: stored.file });
        }
        const file = siftFiles.get(source)!.file;
        const at = file.units.findIndex((x) => x.id === u.after.id);
        if (at < 0) throw new SiftError("EDIT_CONFLICT", `${siftPathFor(source)} no longer describes ${u.ref}.`);
        if (u.before && file.units[at]!.bodyHash !== u.before.bodyHash) throw new SiftError("EDIT_CONFLICT", `The description of ${u.ref} changed since this change was proposed; propose it again.`);
        file.units[at] = u.after;
      }
      for (const [source, { file }] of siftFiles) {
        const proposed = proposal.files.find((f) => f.path === source);
        // The .sift file still matches its source if it did before and every unit of the new code is described.
        if (proposed && file.fileHash === proposed.beforeFileHash && !proposal.newUnits.some((r) => fileOfId(r) === source)) file.fileHash = proposed.afterFileHash;
        file.sift = Math.max(file.sift, requiredSchemaVersion(file));
        validateSiftFile(JSON.parse(JSON.stringify(file)), source);
      }

      // Write sources, then descriptions; record every pre-image first so a failure can be undone.
      for (const f of proposal.files) if (!options.sourceWritten) record.files.push({ path: f.path, before: texts.get(f.path)!, afterHash: textHash(f.text) });
      for (const [source, { before }] of siftFiles) record.files.push({ path: siftPathFor(source), before, afterHash: "" });
      const out: string[] = [];
      for (const f of proposal.files) {
        if (options.sourceWritten) continue;
        await writeFileAtomic(join(root, f.path), f.text);
        out.push(f.path);
      }
      for (const [source, { file }] of siftFiles) {
        const result = await writeSiftFile(root, file);
        const text = await readFile(join(root, result.path), "utf8");
        record.files.find((r) => r.path === result.path)!.afterHash = textHash(text);
        out.push(result.path);
      }
      await mkdir(join(root, EDITS_DIR, "applied"), { recursive: true });
      await writeFileAtomic(join(root, EDITS_DIR, "applied", `${req.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      return out;
    });
    req.state = "applied";
    await this.save(req);
    this.host.changed(written.filter((p) => p.startsWith(`${SIFT_DIR}/`)), "descriptions");
    return { request: req, written };
  }

  /**
   * Restore the files an applied edit wrote, only if each still holds exactly what the edit wrote.
   * Otherwise nothing is restored and the error names the files that changed since (git still can).
   */
  async undo(id: string): Promise<{ request: ChangeRequest; restored: string[] }> {
    const req = await this.load(id);
    this.expectState(req, ["applied"], "undone");
    const path = join(this.host.root, EDITS_DIR, "applied", `${id}.json`);
    if (!existsSync(path)) throw new SiftError("EDIT_NOT_FOUND", `There is no undo record for ${id}.`);
    const record = JSON.parse(await readFile(path, "utf8")) as AppliedRecord;
    const restored = await this.host.exclusive(async () => {
      const changed: string[] = [];
      for (const f of record.files) {
        const now = await readFile(join(this.host.root, f.path), "utf8").catch(() => null);
        if (now === null || textHash(now) !== f.afterHash) changed.push(f.path);
      }
      if (changed.length > 0) throw new SiftError("EDIT_CONFLICT", `Cannot undo ${id}: these files changed after it was applied. Use git to restore them if needed.`, changed);
      for (const f of record.files) {
        if (f.before === null) await rm(join(this.host.root, f.path), { force: true });
        else await writeFileAtomic(join(this.host.root, f.path), f.before);
      }
      return record.files.map((f) => f.path);
    });
    await rm(path, { force: true });
    req.state = "undone";
    await this.save(req);
    this.host.changed(restored.filter((p) => p.startsWith(`${SIFT_DIR}/`)), "descriptions");
    return { request: req, restored };
  }

  private async holdsProposal(proposal: EditProposal): Promise<boolean> {
    for (const f of proposal.files) if ((await readFile(join(this.host.root, f.path), "utf8").catch(() => null)) !== f.text) return false;
    return true;
  }

  // ---------------------------------------------------------------- storage

  private async ids(): Promise<string[]> {
    const dir = join(this.host.root, EDITS_DIR);
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).filter((f) => /^e_[a-z2-7]{8}\.json$/.test(f)).map((f) => f.slice(0, -5));
  }

  private async load(id: string): Promise<ChangeRequest> {
    if (!/^e_[a-z2-7]{8}$/.test(id)) throw new SiftError("EDIT_NOT_FOUND", `"${id}" is not a change request ID (e_ and 8 letters or digits).`);
    const path = join(this.host.root, EDITS_DIR, `${id}.json`);
    let req: ChangeRequest;
    try {
      req = JSON.parse(await readFile(path, "utf8")) as ChangeRequest;
    } catch {
      throw new SiftError("EDIT_NOT_FOUND", `There is no change request ${id}.`);
    }
    // A pipeline that stopped with its process (planning, proposing) left a draft behind.
    if ((req.state === "planning" || req.state === "proposing") && !this.running.has(id)) req.state = "draft";
    return req;
  }

  private async save(req: ChangeRequest): Promise<void> {
    req.updatedAt = new Date().toISOString();
    await mkdir(join(this.host.root, EDITS_DIR), { recursive: true });
    await writeFileAtomic(join(this.host.root, EDITS_DIR, `${req.id}.json`), `${JSON.stringify(req, null, 2)}\n`);
    this.host.changed([req.id], "edits");
  }

  private reset(req: ChangeRequest): void {
    req.state = "draft";
    delete req.proposal;
    delete req.error;
    delete req.review;
    delete req.questions;
    delete req.plan;
  }

  private expectState(req: ChangeRequest, states: EditState[], action: string): void {
    if (states.includes(req.state)) return;
    const why: Partial<Record<EditState, string>> = {
      "needs-review": `${req.review ?? "The code changed since it was written."} Re-plan it against the current code, or reject it.`,
      applied: "It has been applied.",
      undone: "It was applied and undone.",
      rejected: "It was rejected; change it to reopen it.",
    };
    throw new SiftError("EDIT_INVALID_STATE", `${req.id} is ${req.state} and cannot be ${action}. ${why[req.state] ?? ""}`.trim());
  }
}

// ------------------------------------------------------------------ one pipeline run

class Run {
  private readonly ref: string;
  private graph!: CodeGraph;
  private known = new Map<string, { id: string; summary?: string }>();
  private extraction!: FileExtraction;
  private extracted!: ExtractedUnit;
  private fileText!: string;
  private draft!: SiftUnit;

  constructor(
    private readonly host: EditHost,
    private readonly req: ChangeRequest,
    private readonly router: Router,
    private readonly options: { signal?: AbortSignal; onEvent?: (e: EditEvent) => void },
  ) {
    this.ref = unitId(req.file, req.symbol);
  }

  async pipeline(): Promise<void> {
    const { req } = this;
    // 1. Snapshot: the code must be what the edit was written against.
    this.extraction = await this.host.extraction(req.file);
    const now = this.extraction.units.find((u) => u.symbol === req.symbol);
    if (!now || now.bodyHash !== req.base.bodyHash) {
      req.state = "needs-review";
      req.review = now ? "The code changed since this edit was written." : `${req.symbol} is no longer in ${req.file}.`;
      return;
    }
    this.extracted = now;
    this.fileText = await readFile(join(this.host.root, req.file), "utf8");
    this.draft = applyDescriptionEdits(req.base.description, req.edits);
    this.graph = await this.host.graph();
    for (const [id, { source, unit }] of await this.host.unitIndex()) this.known.set(unitId(source, unit.symbol), { id, summary: unit.summary });

    // 2–4. Locate, scope, plan.
    this.stage("planning");
    req.state = "planning";
    const plan = await this.plan();
    req.plan = plan;
    if (plan.questions.length > 0) {
      req.rounds = (req.rounds ?? 0) + 1;
      if (req.rounds > 3) throw new SiftError("EDIT_INVALID_STATE", "The request is still unclear after three rounds of questions. Rephrase it with the details the questions asked about.", plan.questions.map((q) => q.text));
      req.questions = plan.questions.slice(0, MAX_QUESTIONS);
      req.state = "needs-answers";
      return;
    }
    if (plan.kind === "unclear") throw new SiftError("EDIT_INVALID_STATE", `Sift could not tell what to change: ${plan.interpretation}`);
    if (plan.kind === "reword") return this.reword(plan);

    // 5–6. Code, validated, with one retry on parse or type errors.
    req.state = "proposing";
    let code = await this.code(plan, undefined);
    let checked = await this.validate(plan, code);
    if (checked.retry.length > 0) {
      code = await this.code(plan, { previous: JSON.stringify(code, null, 1), problems: checked.retry });
      checked = await this.validate(plan, code);
    }
    const failedCheck = checked.checks.find((c) => c.status === "failed");
    if (failedCheck) {
      const scope = failedCheck.kind === "scope";
      throw new SiftError(
        "EDIT_INVALID_STATE",
        scope ? "The proposed code changed code outside the request, so it was rejected." : `The proposed code does not ${failedCheck.kind === "parse" ? "parse" : "type-check"}, even after a retry with the errors.`,
        checked.checks.filter((c) => c.status === "failed").flatMap((c) => c.details),
      );
    }

    // 7. Re-derive the description from the proposed code, and check it against the request.
    this.stage("describing");
    const units = await this.rederive(plan, checked);
    const main = units.find((u) => u.after.id === req.unitId) ?? units[0];
    this.stage("verifying");
    const verify = main ? await this.verifyIntent("behavior", plan, main.before ?? req.base.description, main.after, main.logic) : null;

    // 8. Ready for review.
    const before = req.base.description.effects;
    const after = main?.after.effects ?? before;
    const effects = { added: after.filter((e) => !before.includes(e)), removed: before.filter((e) => !after.includes(e)) };
    const warnings = [...plan.warnings];
    for (const e of effects.removed) warnings.push({ kind: "effect-removed", text: `The change removes the ${e} effect from ${req.symbol}. Check that this was intended.` });
    warnings.push(...wordingWarnings(this.draft, main?.after));
    const changed = checked.changed;
    const impact = this.graph.impact(changed.filter((r) => this.graph.unit(r)));
    const checks = [...checked.checks, ...this.commandChecks()];
    req.proposal = {
      kind: "behavior",
      files: checked.files,
      units,
      newUnits: checked.newUnits,
      scope: {
        changed,
        allowed: plan.allowedUnits.map((u) => u.unit),
        affected: { units: impact.units.map((u) => u.id).filter((id) => !changed.includes(id)), routes: impact.routes.map((r) => r.id) },
        broader: plan.broader && plan.broader.units.length > 0 ? plan.broader : null,
      },
      checks,
      effects,
      verify,
      warnings,
      notes: code.notes,
    };
    req.state = "ready";
  }

  // ---------------------------------------------------------------- plan

  private async plan(): Promise<EditPlan> {
    const { req, graph, ref } = this;
    const neighbour = (id: string, via?: string): Neighbour => {
      const n: Neighbour = { ref: id };
      const summary = this.known.get(id)?.summary;
      if (summary) n.summary = summary;
      const effects = graph.unit(id)?.effects;
      if (effects && effects.length > 0) n.effects = effects;
      if (via) n.via = via;
      return n;
    };
    const callees = this.calleeList();
    const callers = graph.callers(ref, 2).filter((h) => graph.unit(h.id)).map((h) => neighbour(h.id));
    const member = this.extracted.implementsMember ? unitId(this.extracted.implementsMember.file, this.extracted.implementsMember.symbol) : null;
    const implementations = member ? [neighbour(member), ...graph.implementers(member).filter((i) => i !== ref).map((i) => neighbour(i))] : [];
    const routes = graph.impact([ref]).routes.map((r) => r.id.slice("route:".length));
    const examples = EFFECTS.filter((e) => e !== "throws" && e !== "log").flatMap((effect) => {
      const units = graph.units().filter((u) => u.effects.includes(effect) && unitId(u.file, u.symbol) !== ref).slice(0, 2).map((u) => neighbour(unitId(u.file, u.symbol)));
      return units.length > 0 ? [{ effect, units }] : [];
    });
    const input = renderPlanInput({
      file: req.file,
      unit: { ref, kind: this.extracted.kind, signature: this.extracted.signature, code: annotatedSource(this.fileText, this.extracted) },
      // The description as it was, so the plan sees what the person changed against what it said.
      description: req.base.description,
      edits: req.edits,
      ...(req.request ? { request: req.request } : {}),
      answers: req.answers,
      callees,
      callers,
      implementations,
      types: this.extracted.typeRefs.map((t) => unitId(t.file, t.symbol)),
      routes,
      examples,
    });
    return this.ask("edit-plan", input.prompt, PLAN_SCHEMA, (json) => {
      const v = validatePlan(json, ref, (r) => graph.unit(r) !== undefined);
      return { value: v.plan, problems: v.problems };
    });
  }

  private calleeList(): Neighbour[] {
    const seen = new Set<string>();
    const out: Neighbour[] = [];
    for (const node of flatten(this.extracted.body)) {
      for (const call of node.calls) {
        const target = call.external ? `ext:${call.external.module}#${call.external.name}` : call.target ? unitId(call.target.file, call.target.symbol) : null;
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const n: Neighbour = { ref: target.startsWith("ext:") ? target.slice(4) : target, via: call.expression };
        const summary = this.known.get(target)?.summary;
        if (summary) n.summary = summary;
        const effects = this.host.rules.effectsFor(call);
        if (effects.length > 0) n.effects = effects;
        out.push(n);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- code

  private async code(plan: EditPlan, retry: { previous: string; problems: string[] } | undefined): Promise<CodeResponse> {
    this.stage("coding", retry ? 2 : 1);
    const files = [...new Set(plan.allowedUnits.map((u) => fileOfId(u.unit)!))];
    const extractions = await this.host.extractions(files);
    const units = plan.allowedUnits.map((a) => {
      const file = fileOfId(a.unit)!;
      const symbol = a.unit.slice(file.length + 1);
      const u = extractions.get(file)!.units.find((x) => x.symbol === symbol);
      if (!u) throw new SiftError("EDIT_INVALID_STATE", `${a.unit} is not in the code.`);
      return { u, file };
    });
    const texts = new Map<string, string>();
    for (const f of files) texts.set(f, f === this.req.file ? this.fileText : await readFile(join(this.host.root, f), "utf8"));
    const project = await this.host.project(this.req.file);
    const types = [...new Map(units.flatMap(({ u }) => u.typeRefs).map((t) => [unitId(t.file, t.symbol), t])).values()].flatMap((t) => {
      const text = project.declarationText?.(t);
      return text ? [{ ref: unitId(t.file, t.symbol), text: text.length > 4000 ? `${text.slice(0, 4000)}\n// …` : text }] : [];
    });
    const exampleFiles = [...new Set(plan.examples.map((e) => fileOfId(e)!))];
    const exampleExtractions = await this.host.extractions(exampleFiles);
    const examples: { ref: string; code: string }[] = [];
    for (const e of plan.examples.slice(0, 3)) {
      const file = fileOfId(e)!;
      const u = exampleExtractions.get(file)?.units.find((x) => unitId(file, x.symbol) === e);
      if (u) examples.push({ ref: e, code: unitText(await readFile(join(this.host.root, file), "utf8"), u) });
    }
    const unitContexts = units.map(({ u, file }) => ({ ref: unitId(file, u.symbol), kind: u.kind, signature: u.signature, code: unitText(texts.get(file)!, u), file }));
    const input = renderCodeInput({
      plan,
      edits: this.req.edits,
      ...(this.req.request ? { request: this.req.request } : {}),
      answers: this.req.answers,
      base: this.req.base.description,
      units: unitContexts,
      imports: files.map((f) => ({ file: f, text: texts.get(f)!.slice(0, endOfImports(texts.get(f)!)) })),
      types,
      callees: this.calleeList(),
      examples,
      ...(retry ? { retry } : {}),
    });
    if (unitContexts.some((u) => redactSecrets(u.code).count > 0)) {
      throw new SiftError("EDIT_INVALID_STATE", "A unit to change contains what looks like a secret. Sift never sends secrets to a model, so it cannot rewrite that unit; edit it by hand.");
    }
    return this.ask("edit-code", input.prompt, CODE_SCHEMA, (json) => {
      const v = validateCode(json, plan);
      return { value: v.code, problems: v.problems };
    });
  }

  // ---------------------------------------------------------------- validate

  private async validate(plan: EditPlan, code: CodeResponse): Promise<Validated> {
    this.stage("validating");
    const root = this.host.root;
    const byFile = new Map<string, { replacements: SourceReplacement[]; insertions: SourceInsertion[] }>();
    const entry = (f: string) => byFile.get(f) ?? byFile.set(f, { replacements: [], insertions: [] }).get(f)!;
    for (const u of code.units) entry(fileOfId(u.unit)!).replacements.push({ symbol: u.unit.slice(fileOfId(u.unit)!.length + 1), text: u.text });
    for (const i of code.insertions) entry(i.file).insertions.push({ at: i.at, text: i.text });
    const before = await this.host.extractions([...byFile.keys()]);
    const overlays = new Map<string, string>();
    const files: Validated["files"] = [];
    const parseProblems: string[] = [];
    for (const [file, changes] of byFile) {
      const text = file === this.req.file ? this.fileText : await readFile(join(root, file), "utf8");
      let next: string;
      try {
        next = applySourceChanges(text, before.get(file)!, changes.replacements, changes.insertions);
      } catch (err) {
        parseProblems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      overlays.set(file, next);
      files.push({ path: file, beforeHash: textHash(text), beforeFileHash: this.host.hashFile(file, text), afterFileHash: this.host.hashFile(file, next), text: next, diff: unifiedDiff(file, text, next) });
    }
    const project = await this.host.project(this.req.file);
    if (!project.extractText || !project.diagnostics) throw new SiftError("NOT_IMPLEMENTED", "This language's support cannot check proposed code yet.");

    const checks: CheckResult[] = [];
    const after = new Map<string, FileExtraction>();
    for (const [file, text] of overlays) after.set(file, project.extractText(file, text));
    const diagnostics = parseProblems.length > 0 ? [] : project.diagnostics(overlays, [...overlays.keys()]);
    const syntax = diagnostics.filter((d) => isSyntax(d));
    const types = diagnostics.filter((d) => !isSyntax(d) && d.severity === "error");
    checks.push({ name: "parses", kind: "parse", status: parseProblems.length + syntax.length > 0 ? "failed" : "passed", details: [...parseProblems, ...syntax.map(formatDiagnostic)] });
    checks.push({ name: "type-checks", kind: "type-check", status: parseProblems.length > 0 ? "skipped" : types.length > 0 ? "failed" : "passed", details: types.map(formatDiagnostic) });

    // Scope: only allowed units change; new units only as named helpers; nothing else moves.
    const allowed = new Set(plan.allowedUnits.map((u) => u.unit));
    const changed: string[] = [];
    const newUnits: string[] = [];
    const violations: string[] = [];
    for (const [file, next] of after) {
      const old = before.get(file)!;
      for (const u of old.units) {
        const ref = unitId(file, u.symbol);
        const now = next.units.find((x) => x.symbol === u.symbol);
        if (!now) violations.push(allowed.has(ref) ? `${ref} was renamed or removed; keep its name.` : `${ref} was removed, but it was not part of the request.`);
        else if (now.bodyHash !== u.bodyHash) {
          if (allowed.has(ref)) changed.push(ref);
          else violations.push(`${ref} changed, but it was not part of the request.`);
        }
      }
      for (const u of next.units) {
        if (old.units.some((x) => x.symbol === u.symbol)) continue;
        const ref = unitId(file, u.symbol);
        const last = u.symbol.slice(u.symbol.lastIndexOf(".") + 1);
        if (plan.helpers.some((h) => h.file === file && (h.name === u.symbol || h.name === last))) newUnits.push(ref);
        else violations.push(`${ref} is new, but the plan did not name it as a helper.`);
      }
    }
    if (parseProblems.length === 0 && syntax.length === 0) checks.push({ name: "scope", kind: "scope", status: violations.length > 0 ? "failed" : "passed", details: violations });
    const retry = [...parseProblems, ...syntax.map(formatDiagnostic), ...types.map(formatDiagnostic)];
    return { files, overlays, after, before, checks, changed, newUnits, retry: violations.length > 0 ? [] : retry };
  }

  // ---------------------------------------------------------------- re-derive

  private async rederive(plan: EditPlan, v: Validated): Promise<ProposedUnit[]> {
    const { req } = this;
    const provider = this.host.provider!;
    const index = await this.host.unitIndex();
    // Signatures of what the new code calls come from the callees' files.
    const calleeFiles = new Set<string>();
    for (const e of v.after.values()) for (const u of e.units) for (const n of flatten(u.body)) for (const c of n.calls) if (c.target) calleeFiles.add(c.target.file);
    const extractions = await this.host.extractions([...calleeFiles].filter((f) => !v.after.has(f) && this.graph.files.includes(f)));
    for (const [f, e] of v.after) extractions.set(f, e);
    const out: ProposedUnit[] = [];
    const note = [
      "This code was just changed on a person's request; the description must now say what the new code does.",
      `What was asked: ${plan.interpretation}`,
      ...req.answers.map((a) => `They were asked "${a.question}" and answered "${a.answer}"; the description must make that answer visible.`),
    ].join("\n");
    for (const ref of v.changed) {
      const file = fileOfId(ref)!;
      const symbol = ref.slice(file.length + 1);
      const unit = v.after.get(file)!.units.find((u) => u.symbol === symbol)!;
      const isMain = file === req.file && symbol === req.symbol;
      const current = [...index.values()].find((x) => x.source === file && x.unit.symbol === symbol)?.unit ?? null;
      if (!isMain && !current) continue; // an undescribed unit stays undescribed; generate describes it
      const previous = isMain ? this.draft : current!;
      const effects = effectsOfUnit(unit, this.host.rules).effects;
      const lite = unit.isSmall && !clearsLite(effects) && previous.lite === true;
      const { unit: described, report } = await redescribeUnit({
        root: this.host.root,
        config: this.host.config,
        rules: this.host.rules,
        provider,
        router: this.router,
        graph: this.graph,
        extractions,
        known: this.known,
        file,
        unit,
        previous,
        lite,
        fileText: v.overlays.get(file)!,
        note,
        cache: new SiftCache(this.host.root),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
      this.addUsage(report.usage, "update");
      if (!described) throw new SiftError("PROVIDER_FAILED", `The description of the proposed ${ref} could not be written.`, report.failed.flatMap((f) => [f.reason, ...f.problems]));
      const uncovered = report.described[0]?.uncovered ?? [];
      // Provenance: the person's pieces stay theirs while their text is unchanged; nothing is verified any more.
      carryProvenance(previous, described, { keepVerified: false });
      described.status = uncovered.length > 0 ? "stale" : "generated";
      if (isMain) {
        // Warnings the edit answered stay visible as resolved until the next update drops them.
        for (const w of req.base.description.warnings) {
          if (w.resolved || described.warnings.some((x) => x.id === w.id || x.kind === w.kind)) continue;
          described.warnings.push({ ...w, resolved: { by: "edit", note: plan.interpretation } });
        }
      }
      out.push({ ref, before: isMain ? req.base.description : current, after: described, logic: logicDiff(isMain ? req.base.description : current, described) });
    }
    return out;
  }

  // ---------------------------------------------------------------- reword

  private async reword(plan: EditPlan): Promise<void> {
    const { req } = this;
    const after = structuredClone(this.draft);
    if (after.status === "verified") after.status = "generated";
    const clear = (steps: SiftStep[]): void => steps.forEach((s) => (s.status === "verified" && delete s.status, clear(s.steps)));
    clear(after.steps);
    const diff = logicDiff(req.base.description, after);
    this.stage("verifying");
    const verify = await this.verifyIntent("reword", plan, req.base.description, after, diff);
    if (!verify.satisfied) {
      throw new SiftError("EDIT_INVALID_STATE", "The new wording does not match what the code does, so it was not accepted. To change the code, phrase it as a change request.", verify.gaps);
    }
    if (req.edits.some((e) => e.op === "add" || e.op === "delete")) {
      throw new SiftError("EDIT_INVALID_STATE", "Adding or deleting a step changes what the code does; phrase it as a change request.");
    }
    req.proposal = {
      kind: "reword",
      files: [],
      units: [{ ref: this.ref, before: req.base.description, after, logic: diff }],
      newUnits: [],
      scope: { changed: [], allowed: [], affected: { units: [], routes: [] }, broader: null },
      checks: [{ name: "code unchanged", kind: "scope", status: "passed", details: [] }],
      effects: { added: [], removed: [] },
      verify,
      warnings: plan.warnings,
      notes: "",
    };
    req.state = "ready";
  }

  // ---------------------------------------------------------------- verify

  private async verifyIntent(mode: "behavior" | "reword", plan: EditPlan, before: SiftUnit, after: SiftUnit, diff: LogicChange[]): Promise<VerifyResponse> {
    const input = renderVerifyInput({
      mode,
      interpretation: plan.interpretation,
      edits: this.req.edits,
      ...(this.req.request ? { request: this.req.request } : {}),
      answers: this.req.answers,
      before,
      after,
      diff,
      ...(mode === "reword" ? { code: { file: this.req.file, text: annotatedSource(this.fileText, this.extracted) } } : {}),
    });
    return this.ask("edit-verify", input.prompt, VERIFY_SCHEMA, (json) => {
      const v = validateVerify(json);
      return { value: v.verify, problems: v.problems };
    });
  }

  private commandChecks(): CheckResult[] {
    return this.host.config.edit.checks.map((c) => ({ name: c.name, kind: "command" as const, status: "skipped" as const, details: ["Not run: run checks to run it against a copy of the project with this change."] }));
  }

  // ---------------------------------------------------------------- AI calls

  /** Send a prompt, check the reply, and retry once with the problems; walk routing fallbacks if a model is unavailable. */
  private async ask<T>(task: Task, prompt: string, schema: object, check: (json: unknown) => { value: T | null; problems: string[] }): Promise<T> {
    const provider = this.host.provider!;
    const template = await loadPrompt(task);
    const schemaNote = provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
    const first = `${prompt}${schemaNote}`;
    let current = first;
    let route = this.router.route(task);
    let problems: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      if ((template.text.length + current.length) / 4 > provider.capabilities.contextTokens(route.choice.model)) {
        throw new SiftError("PROVIDER_FAILED", `The ${task} prompt is larger than ${route.choice.model}'s context budget.`);
      }
      const { result, route: used } = await this.complete(task, route, { task, model: route.choice, promptVersion: template.id, system: template.text, prompt: current, jsonSchema: schema });
      route = used;
      const checked = result.json === undefined ? { value: null, problems: ["The response was not valid JSON. Respond with the JSON object only."] } : check(result.json);
      if (checked.value !== null && checked.problems.length === 0) return checked.value;
      problems = checked.problems;
      current = `${first}\n\nYour previous response had these problems. Return a corrected JSON object.\n${problems.map((p) => `- ${p}`).join("\n")}`;
    }
    throw new SiftError("PROVIDER_FAILED", `The ${task} response did not pass validation after one retry.`, problems);
  }

  private async complete(task: Task, route: Route, request: Parameters<Provider["complete"]>[0]): Promise<{ result: CompletionResult; route: Route }> {
    const provider = this.host.provider!;
    const tried = new Set<Tier>();
    let current = route;
    for (;;) {
      tried.add(current.tier);
      if (this.options.signal?.aborted) throw new SiftError("CANCELLED", "Cancelled.");
      try {
        const result = await provider.complete({ ...request, model: current.choice, ...(this.options.signal ? { signal: this.options.signal } : {}) });
        this.addUsage({ inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0, costUsd: result.usage.costUsd ?? 0, calls: 1 }, task, result.durationMs);
        return { result, route: current };
      } catch (err) {
        if (this.options.signal?.aborted) throw new SiftError("CANCELLED", "Cancelled.");
        if (!(err instanceof SiftError) || err.code !== "MODEL_UNAVAILABLE") throw err;
        const next = this.router.fallbacks(current.tier).find((t) => !tried.has(t));
        // Code generation never runs below its minimum tier (phase-2-design §8.11).
        const nextRoute = next ? this.router.route(task, next) : null;
        if (!nextRoute || nextRoute.belowMinimum) throw err;
        current = nextRoute;
      }
    }
  }

  private addUsage(u: { inputTokens: number; outputTokens: number; costUsd: number; calls: number }, task: Task, durationMs = 0): void {
    const usage = this.req.usage;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.costUsd += u.costUsd;
    usage.calls += u.calls;
    const t = (usage.tasks[task] ??= { calls: 0, durationMs: 0 });
    t.calls += u.calls;
    t.durationMs += durationMs;
  }

  private stage(stage: Extract<EditEvent, { type: "stage" }>["stage"], attempt?: number): void {
    this.options.onEvent?.({ type: "stage", id: this.req.id, stage, ...(attempt !== undefined ? { attempt } : {}) });
  }
}

interface Validated {
  files: EditProposal["files"];
  overlays: Map<string, string>;
  before: Map<string, FileExtraction>;
  after: Map<string, FileExtraction>;
  checks: CheckResult[];
  changed: string[];
  newUnits: string[];
  /** Problems worth one more code attempt (parse and type errors). Empty when there are none, or when the scope check failed. */
  retry: string[];
}

function emptyUsage(): EditUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, tasks: {} };
}

/** TypeScript's syntax errors are TS1xxx. */
function isSyntax(d: Diagnostic): boolean {
  return /^TS1\d{3}$/.test(d.code);
}

function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.range.start.line}:${d.range.start.col} ${d.code}: ${d.message}`;
}

/** Notes for review when the re-derivation reworded text a person wrote. */
function wordingWarnings(draft: SiftUnit, after: SiftUnit | undefined): { kind: string; text: string }[] {
  if (!after || !hasPersonWording(draft)) return [];
  const p = personWording(draft);
  const out: { kind: string; text: string }[] = [];
  if (p.summary && draft.summary !== after.summary) out.push({ kind: "wording-changed", text: `Your summary was reworded to match the code: "${after.summary}"` });
  const steps = new Map<string, string>();
  const walk = (list: SiftStep[], into: Map<string, string>) => list.forEach((s) => (into.set(s.id, s.text), walk(s.steps, into)));
  walk(after.steps, steps);
  const mine = new Map<string, string>();
  const collect = (list: SiftStep[]) => list.forEach((s) => (s.status === "user-edited" && mine.set(s.id, s.text), collect(s.steps)));
  collect(draft.steps);
  for (const [id, text] of mine) {
    const now = steps.get(id);
    if (now === undefined) out.push({ kind: "wording-changed", text: `Your step "${text}" is not in the new description.` });
    else if (now !== text) out.push({ kind: "wording-changed", text: `Your step "${text}" was reworded to match the code: "${now}"` });
  }
  return out;
}

/** A copy of the project to run checks in: everything but node_modules (linked instead), .git, and Sift's own state. */
async function copyProject(root: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "sift-check-")), "project");
  const skip = (src: string) => {
    const rel = src.slice(root.length).replace(/\\/g, "/");
    return rel === "/node_modules" || rel === "/.git" || rel.startsWith("/.sift/.cache") || rel.startsWith("/.sift/edits");
  };
  await cp(root, dir, { recursive: true, filter: (src) => !skip(src) });
  if (existsSync(join(root, "node_modules"))) await symlink(join(root, "node_modules"), join(dir, "node_modules"), "junction");
  return dir;
}

async function runCommand(name: string, command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ name, kind: "command", status: "unavailable", details: [err.message] });
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      const tail = output.trim().split(/\r?\n/).slice(-30);
      if (sig) resolve({ name, kind: "command", status: "failed", details: [`Stopped after ${Math.round(timeoutMs / 1000)}s.`, ...tail] });
      // The command does not exist: 127 from POSIX shells; cmd.exe exits 1 (or 9009) and says so.
      else if (code === 127 || code === 9009 || (code === 1 && /is not recognized as an internal or external command/.test(output))) resolve({ name, kind: "command", status: "unavailable", details: tail });
      else resolve({ name, kind: "command", status: code === 0 ? "passed" : "failed", details: code === 0 ? [] : tail });
    });
  });
}

/** One line per logic change, for terminals. */
export { renderLogicDiff };
