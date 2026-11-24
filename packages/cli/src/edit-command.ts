import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { newStepId, renderLogicDiff, SiftError, type ChangeRequest, type DescriptionEdit, type EditEvent, type Workspace } from "@sift/core";

/**
 * `sift edit` (phase-2-design §8.8): the editing pipeline on the terminal. It prints the plan, asks
 * the questions (or takes `--answer`), prints both diffs and the checks, and changes files only with
 * `--apply` or `sift edit apply`.
 */

export interface EditIO {
  out(text: string): void;
  err(text: string): void;
}

export interface EditDeps {
  /** Asks a question on the terminal; absent when there is no terminal to ask on. */
  ask?: (question: string) => Promise<string>;
  state?: { exitCode: number };
}

const PROBLEMS = 1;

export function registerEdit(program: Command, io: EditIO, deps: EditDeps, open: (cmd: Command, withProvider: boolean) => Promise<Workspace>): void {
  const ask = deps.ask ?? (process.stdin.isTTY ? terminalAsk : undefined);
  const problems = () => {
    if (deps.state) deps.state.exitCode = PROBLEMS;
  };
  const progress = (json: boolean) => (e: EditEvent) => {
    if (json || e.type !== "stage") return;
    const label = { planning: "Planning", coding: "Writing the code", validating: "Checking it", describing: "Describing the new code", verifying: "Comparing it with the request" }[e.stage];
    io.out(`  … ${label}${e.attempt && e.attempt > 1 ? " (again, with the errors)" : ""}`);
  };
  const finish = (req: ChangeRequest, json: boolean) => {
    io.out(json ? JSON.stringify(req, null, 2) : renderRequest(req));
    if (["needs-answers", "failed", "needs-review"].includes(req.state)) problems();
  };

  /** Propose, answering questions from `answers` or the terminal, until there are none left. */
  const proposeLoop = async (ws: Workspace, id: string, answers: Map<string, string>, json: boolean): Promise<ChangeRequest> => {
    let req = await ws.edits.propose(id, { onEvent: progress(json) });
    while (req.state === "needs-answers") {
      const given: { questionId: string; answer: string }[] = [];
      for (const q of req.questions ?? []) {
        let a = answers.get(q.id);
        answers.delete(q.id); // a later round's q1 is a different question
        if (a === undefined && ask && !json) {
          io.out(`\n${q.text}${q.options.length > 0 ? `\n  ${q.options.map((o, i) => `${i + 1}) ${o}`).join("   ")}` : ""}`);
          a = (await ask(q.options.length > 0 ? "Answer (number or text): " : "Answer: ")).trim();
          const n = Number(a);
          if (Number.isInteger(n) && n >= 1 && n <= q.options.length) a = q.options[n - 1]!;
        }
        if (a) given.push({ questionId: q.id, answer: a });
      }
      if (given.length < (req.questions ?? []).length) {
        if (given.length > 0) req = await ws.edits.answer(id, given);
        return req;
      }
      await ws.edits.answer(id, given);
      req = await ws.edits.propose(id, { onEvent: progress(json) });
    }
    return req;
  };

  const applyAndReport = async (ws: Workspace, id: string, confirmBroader: boolean, json: boolean) => {
    const { request, written } = await ws.edits.apply(id, { confirmBroader });
    if (json) io.out(JSON.stringify({ request, written }, null, 2));
    else io.out([`Applied ${id}. Wrote:`, ...written.map((w) => `  ${w}`), `Undo with: sift edit undo ${id}`].join("\n"));
  };

  const edit = program
    .command("edit [symbol]")
    .description("Change code by editing its description or asking in words: plan, write, check, and show the change for review; apply only with --apply")
    .option("--step <id>", "the step to rewrite (with --text)")
    .option("--add-after <id>", "add a step after this one (with --text)")
    .option("--add-first", "add a step at the start of the unit (with --text)")
    .option("--text <text>", "the new text of the step")
    .option("--delete <id...>", "delete steps")
    .option("--summary <text>", "rewrite the summary")
    .option("--returns <text>", "rewrite what the return value means")
    .option("--input <name=text...>", "rewrite what an input means")
    .option("-r, --request <text>", "ask for a change in your own words")
    .option("-a, --answer <q=answer...>", "answer the plan's questions ahead of time, e.g. q1=Yes")
    .option("--apply", "apply the change if it is ready (otherwise it is only shown)")
    .option("--confirm-broader", "confirm a change that reaches beyond the edited unit")
    .option("--run-checks", "run the commands in edit.checks against a copy of the project with the change")
    .option("--json", "print the change request as JSON")
    .addHelpText(
      "after",
      `
Examples:
  sift edit AccountService.withdraw --request "Reject amounts of zero or less"
  sift edit AccountService.transferFunds --step s_b2v7 --text "Save both accounts in one database transaction."
  sift edit list
  sift edit apply e_ab12cd34
  sift edit undo e_ab12cd34`,
    )
    .action(async (symbol: string | undefined, opts: EditOpts, cmd: Command) => {
      if (!symbol) {
        cmd.help();
        return;
      }
      const ws = await open(cmd, true);
      const { unit } = await ws.unit(symbol);
      const edits = editsFrom(opts, unit);
      if (edits.length === 0 && !opts.request) throw new SiftError("EDIT_INVALID_STATE", "Say what to change: --request, or an edit such as --step <id> --text <text>.");
      const created = await ws.edits.create({ unit: symbol, edits, ...(opts.request ? { request: opts.request } : {}) });
      if (!opts.json) {
        const provider = ws.provider!;
        io.out(`Change request ${created.id} for ${created.file}#${created.symbol}${provider.capabilities.local ? "" : ` (code is sent to ${provider.id})`}`);
      }
      let req = await proposeLoop(ws, created.id, parseAnswers(opts.answer ?? []), opts.json === true);
      if (req.state === "ready" && opts.runChecks) req = await ws.edits.runChecks(req.id);
      finish(req, opts.json === true);
      if (req.state === "ready" && opts.apply) await applyAndReport(ws, req.id, opts.confirmBroader === true, opts.json === true);
    });

  edit
    .command("list")
    .description("List change requests (open ones unless --all)")
    .option("--all", "include applied, rejected, and undone requests")
    .option("--json", "print raw JSON")
    .action(async (_o: unknown, cmd: Command) => {
      const opts = merged<{ all?: boolean; json?: boolean }>(cmd);
      const ws = await open(cmd, false);
      const list = await ws.edits.list(opts.all ? {} : { states: ["draft", "needs-answers", "ready", "needs-review", "failed"] });
      if (opts.json) io.out(JSON.stringify(list, null, 2));
      else if (list.length === 0) io.out(opts.all ? "No change requests." : "No open change requests.");
      else io.out(list.map((r) => `${r.id}  ${r.state.padEnd(13)} ${r.file}#${r.symbol}  ${oneLine(r.plan?.interpretation ?? r.request ?? describeEdits(r.edits))}`).join("\n"));
    });

  edit
    .command("show <id>")
    .description("Show a change request: plan, questions, diffs, checks")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, false);
      finish(await ws.edits.get(id), opts.json === true);
    });

  edit
    .command("answer <id> <answers...>")
    .description("Answer a change request's questions (q1=… q2=…) and propose it again")
    .option("--json", "print raw JSON")
    .action(async (id: string, answers: string[], _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, true);
      const req = await ws.edits.get(id);
      const map = parseAnswers(answers);
      await ws.edits.answer(id, (req.questions ?? []).filter((q) => map.has(q.id)).map((q) => ({ questionId: q.id, answer: map.get(q.id)! })));
      for (const q of req.questions ?? []) map.delete(q.id);
      const after = await ws.edits.get(id);
      finish(after.state === "draft" ? await proposeLoop(ws, id, map, opts.json === true) : after, opts.json === true);
    });

  edit
    .command("propose <id>")
    .description("Propose a draft, failed, or re-planned change request again")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, true);
      finish(await proposeLoop(ws, id, new Map(), opts.json === true), opts.json === true);
    });

  edit
    .command("replan <id>")
    .description("Start a change request whose code changed over again from the current code, and propose it")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, true);
      await ws.edits.rebase(id);
      finish(await proposeLoop(ws, id, new Map(), opts.json === true), opts.json === true);
    });

  edit
    .command("checks <id>")
    .description("Run the commands in edit.checks against a copy of the project with the change applied")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, false);
      finish(await ws.edits.runChecks(id), opts.json === true);
    });

  edit
    .command("apply <id>")
    .description("Apply a ready change request: write the code and the description, and record how to undo it")
    .option("--confirm-broader", "confirm a change that reaches beyond the edited unit")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ confirmBroader?: boolean; json?: boolean }>(cmd);
      const ws = await open(cmd, false);
      await applyAndReport(ws, id, opts.confirmBroader === true, opts.json === true);
    });

  edit
    .command("reject <id>")
    .description("Discard a change request")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ws = await open(cmd, false);
      await ws.edits.reject(id);
      io.out(`Rejected ${id}.`);
    });

  edit
    .command("undo <id>")
    .description("Undo an applied change request, if the files it wrote have not changed since")
    .option("--json", "print raw JSON")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const opts = merged<{ json?: boolean }>(cmd);
      const ws = await open(cmd, false);
      const { restored } = await ws.edits.undo(id);
      io.out(opts.json ? JSON.stringify({ restored }, null, 2) : [`Undid ${id}. Restored:`, ...restored.map((r) => `  ${r}`)].join("\n"));
    });
}

/** A subcommand's options merged with `sift edit`'s, which uses the same flag names (--json, --confirm-broader). */
function merged<T>(cmd: Command): T {
  return cmd.optsWithGlobals<T & object>();
}

interface EditOpts {
  step?: string;
  addAfter?: string;
  addFirst?: boolean;
  text?: string;
  delete?: string[];
  summary?: string;
  returns?: string;
  input?: string[];
  request?: string;
  answer?: string[];
  apply?: boolean;
  confirmBroader?: boolean;
  runChecks?: boolean;
  json?: boolean;
}

function editsFrom(opts: EditOpts, unit: import("@sift/core").SiftUnit): DescriptionEdit[] {
  const edits: DescriptionEdit[] = [];
  const targets = [opts.step, opts.addAfter, opts.addFirst ? "first" : undefined].filter(Boolean);
  if (targets.length > 1) throw new SiftError("EDIT_INVALID_STATE", "Use one of --step, --add-after, and --add-first at a time.");
  if (targets.length === 1 && opts.text === undefined) throw new SiftError("EDIT_INVALID_STATE", "Give the step's new text with --text.");
  if (targets.length === 0 && opts.text !== undefined) throw new SiftError("EDIT_INVALID_STATE", "--text needs --step, --add-after, or --add-first.");
  if (opts.step) {
    const step = findText(unit.steps, opts.step);
    if (step === undefined) throw new SiftError("EDIT_INVALID_STATE", `${unit.symbol} has no step ${opts.step}. Its steps are listed by "sift show <file> --json".`);
    edits.push({ op: "set", path: `steps[${opts.step}].text`, before: step, after: opts.text! });
  }
  if (opts.addAfter) edits.push({ op: "add", id: newStepId(unit), text: opts.text!, after: opts.addAfter });
  if (opts.addFirst) edits.push({ op: "add", id: newStepId(unit), text: opts.text! });
  for (const id of opts.delete ?? []) edits.push({ op: "delete", step: id });
  if (opts.summary !== undefined) edits.push({ op: "set", path: "summary", before: unit.summary, after: opts.summary });
  if (opts.returns !== undefined) edits.push({ op: "set", path: "returns.meaning", before: unit.returns?.meaning ?? "", after: opts.returns });
  for (const pair of opts.input ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new SiftError("EDIT_INVALID_STATE", `--input takes name=text, not "${pair}".`);
    const name = pair.slice(0, eq);
    const input = unit.inputs.find((i) => i.name === name);
    edits.push({ op: "set", path: `inputs[${name}].meaning`, before: input?.meaning ?? "", after: pair.slice(eq + 1) });
  }
  return edits;
}

function findText(steps: import("@sift/core").SiftStep[], id: string): string | undefined {
  for (const s of steps) {
    if (s.id === id) return s.text;
    const inner = findText(s.steps, id);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function parseAnswers(values: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new SiftError("EDIT_INVALID_STATE", `Answers take the form q1=answer, not "${v}".`);
    map.set(v.slice(0, eq), v.slice(eq + 1));
  }
  return map;
}

async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function describeEdits(edits: DescriptionEdit[]): string {
  return edits.map((e) => (e.op === "set" ? `${e.path} → "${e.after}"` : e.op === "add" ? `add "${e.text}"` : `delete ${e.step}`)).join("; ");
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The terminal rendering of a change request: plan, questions, diffs, scope, checks, and what to do next. */
export function renderRequest(req: ChangeRequest): string {
  const out: string[] = [`${req.id} · ${req.file}#${req.symbol} · ${req.state}`];
  if (req.request) out.push(`Request: ${req.request}`);
  if (req.edits.length > 0) out.push(`Edits: ${describeEdits(req.edits)}`);
  if (req.plan) out.push("", `Plan (${req.plan.kind}): ${req.plan.interpretation}`);
  for (const a of req.answers) out.push(`  Q: ${a.question}`, `  A: ${a.answer}`);

  if (req.state === "needs-answers") {
    out.push("", "Questions:");
    for (const q of req.questions ?? []) out.push(`  ${q.id}: ${q.text}${q.options.length > 0 ? `  [${q.options.join(" / ")}]` : ""}`);
    out.push("", `Answer with: sift edit answer ${req.id} ${(req.questions ?? []).map((q) => `${q.id}="…"`).join(" ")}`);
  }
  if (req.state === "needs-review") out.push("", `Needs review: ${req.review ?? "the code changed"}`, `Re-plan it against the current code with: sift edit replan ${req.id}   (or: sift edit reject ${req.id})`);
  if (req.state === "failed" && req.error) {
    out.push("", `Failed: ${req.error.message}`, ...req.error.details.map((d) => `  - ${d}`));
    out.push(`Change the request (a new "sift edit") or try again with: sift edit propose ${req.id}`);
  }

  const p = req.proposal;
  if (p) {
    for (const u of p.units) out.push("", `Logic${p.units.length > 1 ? ` of ${u.ref}` : ""}:`, ...renderLogicDiff(u.logic).map((l) => `  ${l}`));
    if (p.files.length > 0) {
      out.push("", "Code:");
      for (const f of p.files) out.push(f.diff);
    } else out.push("", "Code: unchanged (only the wording changes).");
    if (p.kind === "behavior") {
      out.push("", "Scope:", `  changes: ${p.scope.changed.join(", ") || "(none)"}`);
      if (p.newUnits.length > 0) out.push(`  adds: ${p.newUnits.join(", ")} (described on the next "sift generate")`);
      if (p.scope.affected.units.length > 0) out.push(`  may affect: ${p.scope.affected.units.join(", ")}`);
      if (p.scope.affected.routes.length > 0) out.push(`  routes: ${p.scope.affected.routes.map((r) => r.replace(/^route:/, "")).join(", ")}`);
      if (p.scope.broader) out.push(`  BROADER CHANGE: ${p.scope.broader.reason} (${p.scope.broader.units.join(", ")}). Applying needs --confirm-broader.`);
      if (p.effects.added.length > 0 || p.effects.removed.length > 0) out.push(`  effects: ${[...p.effects.added.map((e) => `+${e}`), ...p.effects.removed.map((e) => `-${e}`)].join(" ")}`);
    }
    out.push("", "Checks:");
    const mark = { passed: "✓", failed: "✗", skipped: "–", unavailable: "?" } as const;
    for (const c of p.checks) out.push(`  ${mark[c.status]} ${c.name}: ${c.status}${c.details.length > 0 ? `\n${c.details.map((d) => `      ${d}`).join("\n")}` : ""}`);
    if (p.verify) {
      out.push("", p.verify.satisfied ? "Matches the request." : "Does not fully match the request:");
      for (const g of p.verify.gaps) out.push(`  missing: ${g}`);
      for (const u of p.verify.unrequested) out.push(`  not asked for: ${u}`);
    }
    if (p.warnings.length > 0) out.push("", "Warnings:", ...p.warnings.map((w) => `  ${w.kind}: ${w.text}`));
    if (p.notes) out.push("", `Notes: ${p.notes}`);
    if (req.state === "ready") out.push("", `Apply with: sift edit apply ${req.id}${p.scope.broader ? " --confirm-broader" : ""}   (or: sift edit reject ${req.id})`);
  }
  if (req.state === "applied") out.push("", `Applied. Undo with: sift edit undo ${req.id}`);
  return out.join("\n");
}
