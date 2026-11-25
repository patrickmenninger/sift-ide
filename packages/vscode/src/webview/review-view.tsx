import { useEffect, useState } from "preact/hooks";
import type { CheckResult, ChangeRequest, LogicChange, ProposedUnit } from "@sift/core";
import { wordDiff } from "./edit-model.js";
import { displayName } from "./model.js";
import type { ReviewHostMessage, ReviewState, ReviewWebviewMessage } from "./review-protocol.js";

/**
 * The review panel (phase-2-design §8.8): in order, what was asked and how Sift read it, the logic
 * diff (word by word), the source diff, the scope, the checks, then warnings and the intent check.
 * Approve and Reject at the top and the bottom. Nothing is called "correct": checks say exactly
 * what ran.
 */
export function ReviewView({ post }: { post: (m: ReviewWebviewMessage) => void }) {
  const [state, setState] = useState<ReviewState | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent<ReviewHostMessage>) => {
      if (event.data.type === "state") setState(event.data.state);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!state) return <main class="doc review"><p class="muted">Loading…</p></main>;
  const req = state.request;
  if (!req) return <main class="doc review">{state.error ? <div class="banner error">{state.error}</div> : <p class="muted">Loading…</p>}</main>;
  const proposal = req.proposal;
  const symbol = displayName(req.symbol);

  return (
    <main class="doc review">
      <header class="doc-header">
        <h1 title={`${req.file}#${req.symbol}`}>Change to {symbol}</h1>
        <span class={`badge state-${req.state}`}>{STATE_LABELS[req.state] ?? req.state}</span>
      </header>
      {state.error && <div class="banner error">{state.error}</div>}
      <Status state={state} req={req} post={post} />
      {proposal?.scope.broader && (
        <div class="banner warning broader-scope">
          <strong>This change reaches beyond {symbol}.</strong> {proposal.scope.broader.reason} Applying it asks you to confirm again.
          {proposal.scope.broader.units.length > 0 && (
            <div class="also">
              Also changes: <UnitList refs={proposal.scope.broader.units} post={post} />
            </div>
          )}
        </div>
      )}
      {proposal?.verify && !proposal.verify.satisfied && (
        <div class="banner warning">
          <strong>The new logic may not do everything you asked.</strong> See the notes below.
        </div>
      )}

      <section>
        <h2>What you asked</h2>
        {req.request && <blockquote class="asked">{req.request}</blockquote>}
        {req.edits.length > 0 && (
          <p class="muted">
            {req.edits.length} edit{req.edits.length === 1 ? "" : "s"} to the description (shown in the logic changes below).
          </p>
        )}
        {req.answers.length > 0 && (
          <dl class="answers">
            {req.answers.map((a) => (
              <div key={a.questionId + a.question}>
                <dt>{a.question}</dt>
                <dd>{a.answer}</dd>
              </div>
            ))}
          </dl>
        )}
        {req.plan?.interpretation && (
          <p class="interpretation">
            <span class="label">Sift read it as:</span> {req.plan.interpretation}
          </p>
        )}
      </section>

      {proposal && (
        <>
          <section>
            <h2>Logic changes</h2>
            {proposal.units.map((u) => (
              <UnitChanges key={u.ref} unit={u} post={post} />
            ))}
            {proposal.newUnits.length > 0 && (
              <p class="muted">
                New: {proposal.newUnits.map((r) => displayName(r.slice(r.indexOf("#") + 1))).join(", ")}. {proposal.newUnits.length === 1 ? "It is" : "They are"} described on the next update.
              </p>
            )}
            {proposal.units.length === 0 && <p class="muted">No description changes.</p>}
          </section>

          <section>
            <h2>Code changes</h2>
            {proposal.files.length === 0 && <p class="muted">The code does not change; only the wording does.</p>}
            {proposal.files.map((f) => (
              <div class="file-diff" key={f.path}>
                <div class="file-diff-header">
                  <code>{f.path}</code>
                  <button class="secondary small" onClick={() => post({ type: "openDiff", path: f.path })}>
                    Open diff
                  </button>
                </div>
                <UnifiedDiff text={f.diff} />
              </div>
            ))}
          </section>

          <section>
            <h2>Scope</h2>
            <dl class="scope">
              <dt>Code changes in</dt>
              <dd>{proposal.scope.changed.length > 0 ? <UnitList refs={proposal.scope.changed} post={post} /> : <span class="muted">none</span>}</dd>
              <dt>May affect</dt>
              <dd>{proposal.scope.affected.units.length > 0 ? <UnitList refs={proposal.scope.affected.units} post={post} limit={12} /> : <span class="muted">nothing else found in the code graph</span>}</dd>
              {proposal.scope.affected.routes.length > 0 && (
                <>
                  <dt>Routes reached</dt>
                  <dd>
                    {proposal.scope.affected.routes.map((r) => (
                      <code key={r} class="route">
                        {r.replace(/^route:/, "")}
                      </code>
                    ))}
                  </dd>
                </>
              )}
              {(proposal.effects.added.length > 0 || proposal.effects.removed.length > 0) && (
                <>
                  <dt>Effects</dt>
                  <dd>
                    <EffectChanges added={proposal.effects.added} removed={proposal.effects.removed} />
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section>
            <h2>Checks</h2>
            <ul class="checks">
              {proposal.checks.map((c, i) => (
                <Check key={`${c.name}-${i}`} check={c} />
              ))}
            </ul>
            {req.state === "ready" && proposal.files.length > 0 && (
              <p class="checks-run">
                <button class="secondary small" disabled={state.activity !== null} onClick={() => post({ type: "runChecks" })}>
                  {state.activity === "checks" ? "Running checks…" : "Run configured checks"}
                </button>{" "}
                <span class="muted">Runs the commands in edit.checks on a copy of the project with this change. This runs the new code.</span>
              </p>
            )}
          </section>

          <section>
            <h2>Warnings and notes</h2>
            <Notes req={req} />
          </section>
        </>
      )}
      <Status state={state} req={req} post={post} bottom />
    </main>
  );
}

const STATE_LABELS: Partial<Record<ChangeRequest["state"], string>> = {
  ready: "Ready to review",
  applied: "Applied",
  rejected: "Rejected",
  undone: "Undone",
  "needs-review": "Code changed",
  failed: "Failed",
  draft: "Draft",
  "needs-answers": "Questions",
};

/** The decision: Approve / Reject while ready; what happened otherwise. */
function Status({ state, req, post, bottom }: { state: ReviewState; req: ChangeRequest; post: (m: ReviewWebviewMessage) => void; bottom?: boolean }) {
  const busy = state.activity !== null;
  if (state.activity && !["checks", "applying", "undoing"].includes(state.activity)) return <div class="banner info">Sift is proposing this change again…</div>;
  if (req.state === "ready") {
    return (
      <div class={bottom ? "decision bottom" : "decision"}>
        {state.dirty.length > 0 && !bottom && (
          <div class="banner warning">
            {state.dirty.join(", ")} {state.dirty.length === 1 ? "has" : "have"} unsaved changes. Save or revert {state.dirty.length === 1 ? "it" : "them"} before applying.
          </div>
        )}
        <button disabled={busy || state.dirty.length > 0} onClick={() => post({ type: "approve" })} title="Write the change to the code and the description. VS Code's Undo, or Sift: Undo Edit, takes it back.">
          {state.activity === "applying" ? "Applying…" : "Approve and apply"}
        </button>
        <button class="secondary" disabled={busy} onClick={() => post({ type: "reject" })}>
          Reject
        </button>
        <button class="secondary" disabled={busy} onClick={() => post({ type: "openLogic" })} title="Back to the unit's logic, to change what you asked for.">
          Change the request
        </button>
      </div>
    );
  }
  if (bottom) return null;
  if (req.state === "applied") {
    return (
      <div class="decision">
        <div class="banner info">Applied. The code and its description were written.</div>
        <button class="secondary" disabled={busy} onClick={() => post({ type: "undo" })} title="Restore the files as they were, if nothing changed them since.">
          {state.activity === "undoing" ? "Undoing…" : "Undo"}
        </button>
      </div>
    );
  }
  if (req.state === "needs-review") {
    return (
      <div class="banner warning">
        {req.review ?? "The code changed since this change was proposed."} It will not be applied. Re-plan it from the unit's logic, or reject it.{" "}
        <button class="link" onClick={() => post({ type: "openLogic" })}>
          Open the logic
        </button>
      </div>
    );
  }
  const text: Partial<Record<ChangeRequest["state"], string>> = {
    rejected: "Rejected. Nothing was written.",
    undone: "Applied, then undone.",
    failed: req.error?.message ?? "Failed.",
    draft: "The request was changed; propose it again to review it.",
    "needs-answers": "Sift has questions about this request; answer them in the unit's logic.",
  };
  return <div class="banner info">{text[req.state] ?? req.state}</div>;
}

function UnitChanges({ unit, post }: { unit: ProposedUnit; post: (m: ReviewWebviewMessage) => void }) {
  const symbol = unit.ref.slice(unit.ref.indexOf("#") + 1);
  return (
    <div class="unit-changes">
      <h3>
        <a href="#" title="Click: open its logic · Alt+click: open its code" onClick={(e) => (e.preventDefault(), post({ type: "openUnit", ref: unit.ref, source: e.altKey }))}>
          {displayName(symbol)}
        </a>
        {!unit.before && <span class="muted"> (no description before)</span>}
      </h3>
      {unit.logic.length === 0 && <p class="muted">The description stays the same.</p>}
      <ul class="logic-diff">
        {unit.logic.map((c, i) => (
          <LogicChangeRow key={i} change={c} />
        ))}
      </ul>
    </div>
  );
}

function LogicChangeRow({ change }: { change: LogicChange }) {
  switch (change.field) {
    case "summary":
      return (
        <li>
          <span class="field">Summary</span> <Words before={change.before} after={change.after} />
        </li>
      );
    case "returns":
      return (
        <li>
          <span class="field">Returns</span> <Words before={change.before} after={change.after} />
        </li>
      );
    case "input":
      return (
        <li>
          <span class="field">
            Input <code>{change.name}</code>
          </span>{" "}
          <Words before={change.before} after={change.after} />
        </li>
      );
    case "step":
      return (
        <li class={`step-change ${change.change}`}>
          <span class="field">{change.change === "added" ? "New step" : change.change === "removed" ? "Removed step" : "Step"}</span>{" "}
          <Words before={change.before ?? null} after={change.after ?? null} />
        </li>
      );
    case "effects":
      return (
        <li>
          <span class="field">Effects</span> <EffectChanges added={change.added} removed={change.removed} />
        </li>
      );
    case "warning":
      return (
        <li class={`warning-change ${change.change}`}>
          <span class="field">{change.change === "added" ? "New warning" : change.change === "resolved" ? "Warning resolved" : "Warning removed"}</span> <span class="warning-kind">{change.kind.replace(/-/g, " ")}</span>{" "}
          {change.text}
        </li>
      );
  }
}

/** Old and new text, word by word: removed words struck through, added ones marked. */
export function Words({ before, after }: { before: string | null; after: string | null }) {
  if (before === null && after !== null) return <ins>{after}</ins>;
  if (after === null && before !== null) return <del>{before}</del>;
  return (
    <span class="words">
      {wordDiff(before ?? "", after ?? "").map((p, i) => (p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "added" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
    </span>
  );
}

function EffectChanges({ added, removed }: { added: string[]; removed: string[] }) {
  return (
    <span class="effects">
      {added.map((e) => (
        <span class="chip added" key={`+${e}`} title="New effect">
          + {e}
        </span>
      ))}
      {removed.map((e) => (
        <span class="chip removed" key={`-${e}`} title="Effect removed">
          − {e}
        </span>
      ))}
    </span>
  );
}

function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
  return (
    <pre class="unified-diff">
      {lines.map((l, i) => (
        <div key={i} class={l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function Check({ check }: { check: CheckResult }) {
  const icon = { passed: "✓", failed: "✗", skipped: "–", unavailable: "?" }[check.status];
  const words: Record<CheckResult["kind"], Record<CheckResult["status"], string>> = {
    parse: { passed: "parses", failed: "does not parse", skipped: "parse not checked", unavailable: "parse check unavailable" },
    "type-check": { passed: "type-checks", failed: "type errors", skipped: "type-check skipped", unavailable: "type-check unavailable" },
    scope: { passed: "changes only what the plan allowed", failed: "changed code outside the request", skipped: "scope not checked", unavailable: "scope check unavailable" },
    effects: { passed: "effects as expected", failed: "effects changed", skipped: "effects not compared", unavailable: "effects unavailable" },
    command: { passed: "passed", failed: "failed", skipped: "not run", unavailable: "unavailable" },
  };
  return (
    <li class={`check ${check.status}`}>
      <span class="check-icon" aria-hidden="true">
        {icon}
      </span>{" "}
      {check.kind === "command" ? (
        <>
          <code>{check.name}</code> {words.command[check.status]}
        </>
      ) : (
        words[check.kind][check.status]
      )}
      {check.details.length > 0 && (
        <pre class="check-details">{check.details.slice(-30).join("\n")}</pre>
      )}
    </li>
  );
}

function Notes({ req }: { req: ChangeRequest }) {
  const p = req.proposal!;
  const items: { kind: string; text: string; cls: string }[] = [
    ...(p.verify?.gaps ?? []).map((text) => ({ kind: "Not done", text, cls: "gap" })),
    ...(p.verify?.unrequested ?? []).map((text) => ({ kind: "Not asked for", text, cls: "unrequested" })),
    ...p.warnings.map((w) => ({ kind: w.kind.replace(/-/g, " "), text: w.text, cls: "warning" })),
  ];
  return (
    <>
      {p.verify?.satisfied && p.verify.gaps.length === 0 && p.verify.unrequested.length === 0 && <p class="muted">The new logic matches what you asked, as far as Sift can tell from the description.</p>}
      {!p.verify && <p class="muted">The new logic was not compared with the request.</p>}
      {items.length > 0 && (
        <ul class="notes">
          {items.map((n, i) => (
            <li key={i} class={n.cls}>
              <span class="note-kind">{n.kind}</span> {n.text}
            </li>
          ))}
        </ul>
      )}
      {p.notes && (
        <p class="code-notes">
          <span class="label">From the code step:</span> {p.notes}
        </p>
      )}
    </>
  );
}

function UnitList({ refs, post, limit = 50 }: { refs: string[]; post: (m: ReviewWebviewMessage) => void; limit?: number }) {
  const shown = refs.slice(0, limit);
  return (
    <span class="unit-list">
      {shown.map((r, i) => (
        <span key={r}>
          {i > 0 && ", "}
          <a href="#" title={`${r}\nClick: open its logic · Alt+click: open its code`} onClick={(e) => (e.preventDefault(), post({ type: "openUnit", ref: r, source: e.altKey }))}>
            {displayName(r.slice(r.indexOf("#") + 1))}
          </a>
        </span>
      ))}
      {refs.length > shown.length && <span class="muted"> and {refs.length - shown.length} more</span>}
    </span>
  );
}
