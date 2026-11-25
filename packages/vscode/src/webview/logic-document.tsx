import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DescriptionEdit, LogicUnit, NavTarget, SiftStep, SiftUnit, SiftWarning } from "@sift/core";
import { addStep, baseOf, canEdit, changes, draftOf, editOf, fieldPath, isEditable, removeStep, revert, setText } from "./edit-model.js";
import { EditPanel, fit } from "./edit-panel.js";
import { canVerify, displayName, isFaint, needsUpdate, stepKey, unitBadge } from "./model.js";
import type { HostMessage, LogicDocumentState, StepRef, UnitEdit, UnitTarget, WebviewMessage } from "./protocol.js";

/**
 * The logic document (phase-2-design §6.1): one continuous document per source file, each unit a
 * collapsible section with its status badge, summary, inputs and returns, effects, nested steps,
 * and warnings. It renders only what the host sends and answers with intents.
 *
 * Editing (§8.1, M15): **Edit** on a unit makes its summary, input and return meanings, and steps
 * editable in place; steps can be added and removed, and a free-form request written. The draft is
 * saved by the host as a change request; the panel under the unit proposes it, asks its
 * questions, and opens the review.
 */
export interface LogicDocumentProps {
  post: (message: WebviewMessage) => void;
  /** Units whose collapsed state the user flipped (lite units start collapsed, the rest open). */
  toggled?: string[];
  onToggled?: (toggled: string[]) => void;
}

interface Card {
  at: StepRef;
  targets: NavTarget[] | null;
  pinned: boolean;
  /** Position relative to the document. */
  top: number;
  left: number;
}

const NAV_HINT = "Click: show the code · Ctrl+click or F12: follow the call · Alt+click: open the callee's code";
const EDIT_HINT = "Click to edit · Ctrl+click or F12: follow the call";

/** A draft not yet confirmed by the host; `seq` matches the host's `draftSaved`. */
interface Pending {
  edits: DescriptionEdit[];
  request: string;
  seq: number;
}

/** What is being typed into in a unit: a field (`path`), or a new step at a place. */
export type Active = { path: string } | { add: { after?: string; parent?: string } };

export function LogicDocument({ post, toggled: initialToggled = [], onToggled }: LogicDocumentProps) {
  const [state, setState] = useState<LogicDocumentState | null>(null);
  const [current, setCurrent] = useState<StepRef | null>(null);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set(initialToggled));
  const [card, setCard] = useState<Card | null>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; block: "start" | "nearest" } | null>(null);
  /** Units opened for editing that may have no change request yet. */
  const [editing, setEditing] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Map<string, Pending>>(() => new Map());
  const [active, setActive] = useState<{ unitId: string; at: Active } | null>(null);
  const seq = useRef(0);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLElement>(null);
  const units = state?.file?.units ?? [];
  const edits = state?.edits ?? [];

  const isCollapsed = (u: LogicUnit) => (u.unit.lite === true) !== toggled.has(u.unit.id);
  const setCollapsed = (u: LogicUnit, collapsed: boolean) => {
    if (isCollapsed(u) === collapsed) return;
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(u.unit.id)) next.delete(u.unit.id);
      else next.add(u.unit.id);
      onToggled?.([...next]);
      return next;
    });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === "state") {
        setState(message.state);
        // Once a unit has a change request, the request keeps it in edit mode; when the request
        // ends (applied, rejected), the unit goes back to reading.
        const withRequest = new Set((message.state.edits ?? []).map((e) => e.request.unitId));
        setEditing((prev) => ([...prev].some((id) => withRequest.has(id)) ? new Set([...prev].filter((id) => !withRequest.has(id))) : prev));
        setCard((c) => (c && message.state.file?.units.some((u) => u.unit.id === c.at.unitId) ? c : null));
      } else if (message.type === "current") {
        setCurrent(message.at);
        if (message.at) setScrollTo({ key: stepKey(message.at), block: "nearest" });
      } else if (message.type === "reveal") {
        setCurrent({ unitId: message.unitId });
        setScrollTo({ key: message.unitId, block: "start" });
      } else if (message.type === "draftSaved") {
        // The state sent before this holds the saved draft, so the local copy can go.
        setPending((prev) => {
          if (prev.get(message.unitId)?.seq !== message.seq) return prev;
          const next = new Map(prev);
          next.delete(message.unitId);
          return next;
        });
      } else if (message.type === "edit") {
        setEditing((prev) => new Set(prev).add(message.unitId));
        setCurrent({ unitId: message.unitId });
        setScrollTo({ key: message.unitId, block: "start" });
      } else if (message.type === "targets") {
        setCard((c) => {
          if (c && stepKey(c.at) === stepKey(message.at)) return { ...c, targets: message.targets, pinned: c.pinned || message.pinned };
          if (!message.pinned) return c;
          const anchor = root.current?.querySelector(`[data-key="${cssEscape(stepKey(message.at))}"] .step-line`);
          return { at: message.at, targets: message.targets, pinned: true, ...cardPosition(anchor, root.current) };
        });
      }
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A step that should be on screen: expand its unit, then scroll once it is rendered.
  useLayoutEffect(() => {
    if (!scrollTo) return;
    const unitId = scrollTo.key.split("/")[0]!;
    const unit = units.find((u) => u.unit.id === unitId);
    if (unit && isCollapsed(unit) && (scrollTo.key !== unitId || editing.has(unitId))) {
      setCollapsed(unit, false);
      return; // runs again after the unit opens
    }
    const el = root.current?.querySelector(`[data-key="${cssEscape(scrollTo.key)}"]`);
    if (el) {
      el.scrollIntoView?.({ block: scrollTo.block });
      setScrollTo(null);
    } else if (!unit) {
      setScrollTo(null);
    }
  }, [scrollTo, toggled, state]);

  useEffect(() => {
    if (!card?.pinned) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "mousedown" && (e.target as Element | null)?.closest?.(".card")) return;
      setCard(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
    };
  }, [card?.pinned]);

  const keepCard = () => {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = null;
  };
  const hideCardSoon = () => {
    keepCard();
    cardTimer.current = setTimeout(() => setCard((c) => (c?.pinned ? c : null)), 250);
  };
  const showCard = (at: StepRef, anchor: Element) => {
    keepCard();
    setCard((c) => (c && stepKey(c.at) === stepKey(at) ? c : { at, targets: null, pinned: false, ...cardPosition(anchor, root.current) }));
    post({ type: "targets", at });
  };

  /** A unit's draft: what the person typed that the host has not confirmed yet, else the stored request. */
  const draftFor = (unitId: string, edit: UnitEdit | undefined): { edits: DescriptionEdit[]; request: string } => {
    const p = pending.get(unitId);
    if (p) return p;
    return { edits: edit?.request.edits ?? [], request: edit?.request.request ?? "" };
  };
  /** Keep a draft locally; `send` also saves it on the host. */
  const changeDraft = (unitId: string, draft: { edits: DescriptionEdit[]; request: string }, send: boolean | "propose") => {
    const n = ++seq.current;
    setPending((prev) => new Map(prev).set(unitId, { ...draft, seq: n }));
    if (send) post({ type: send === "propose" ? "propose" : "draft", unitId, edits: draft.edits, request: draft.request, seq: n });
  };
  const forget = (unitId: string) => {
    setActive((a) => (a?.unitId === unitId ? null : a));
    setEditing((prev) => {
      const next = new Set(prev);
      next.delete(unitId);
      return next;
    });
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(unitId);
      return next;
    });
  };

  const editorFor = (u: LogicUnit): UnitEditor | null => {
    const id = u.unit.id;
    const edit = editOf(edits, id);
    if (!edit && !editing.has(id)) return null;
    const draft = draftFor(id, edit);
    const base = baseOf(u, edit);
    const needsReview = edit?.request.state === "needs-review";
    return {
      edit,
      editable: isEditable(edit) && canEdit(u) && !needsReview,
      base,
      // A request whose code changed is shown against the code as it is now.
      shown: needsReview ? u.unit : draftOf(base, draft.edits),
      edits: draft.edits,
      request: draft.request,
      active: active?.unitId === id ? active.at : null,
      setActive: (at) => setActive(at ? { unitId: id, at } : null),
      setEdits: (next) => changeDraft(id, { edits: next, request: draft.request }, true),
      setRequest: (text, send) => changeDraft(id, { edits: draft.edits, request: text }, send),
      propose: () => {
        setActive(null);
        changeDraft(id, draft, "propose");
      },
      close: () => {
        forget(id);
        if (edit) post({ type: "discard", id: edit.request.id });
      },
    };
  };

  if (!state) return <main class="doc" ref={root}><p class="muted">Loading…</p></main>;
  const { file } = state;

  return (
    <main class="doc" ref={root} onMouseLeave={() => post({ type: "hover", at: null })}>
      <header class="doc-header">
        <h1 title={state.source}>{state.source}</h1>
        {file && needsUpdate(file) && (
          <button class="secondary" onClick={() => post({ type: "describe" })} title="Shows an estimate before anything is sent to the AI.">
            {file.units.length === 0 ? "Describe this file…" : "Update descriptions…"}
          </button>
        )}
      </header>
      {state.dirty && <div class="banner warning">The source has unsaved changes. This describes the saved file.</div>}
      {state.error && <div class="banner error">{state.error}</div>}
      {!file && !state.error && <p class="muted">Loading…</p>}
      {file && file.units.length === 0 && file.undescribed.length === 0 && <p class="muted">Sift found no functions or methods in this file.</p>}
      {file && file.units.length === 0 && file.undescribed.length > 0 && <p class="muted">This file has no description yet.</p>}
      {units.map((u) => (
        <UnitSection
          key={u.unit.id}
          u={u}
          collapsed={isCollapsed(u)}
          current={current}
          post={post}
          editor={editorFor(u)}
          provider={state.provider ?? null}
          onEdit={() => {
            setCollapsed(u, false);
            setEditing((prev) => new Set(prev).add(u.unit.id));
          }}
          onToggle={() => setCollapsed(u, !isCollapsed(u))}
          onCallsEnter={showCard}
          onCallsLeave={hideCardSoon}
        />
      ))}
      {file && file.undescribed.length > 0 && file.units.length > 0 && (
        <section class="undescribed">
          <h2>Not described yet</h2>
          <p>{file.undescribed.map(displayName).join(", ")}</p>
        </section>
      )}
      {card && <TargetCard card={card} post={post} onEnter={keepCard} onLeave={hideCardSoon} onClose={() => setCard(null)} />}
    </main>
  );
}

/** Everything a unit needs while it has a draft or a change request (phase-2-design §8.1). */
export interface UnitEditor {
  edit: UnitEdit | undefined;
  /** Fields can be changed now (not while proposing, and not for a request whose code changed). */
  editable: boolean;
  base: SiftUnit;
  /** The description to show: the draft, or the current one for a request that needs review. */
  shown: SiftUnit;
  edits: DescriptionEdit[];
  request: string;
  active: Active | null;
  setActive: (at: Active | null) => void;
  setEdits: (edits: DescriptionEdit[]) => void;
  setRequest: (text: string, send: boolean) => void;
  propose: () => void;
  /** Stop editing and discard the draft or change request. */
  close: () => void;
}

interface UnitProps {
  u: LogicUnit;
  collapsed: boolean;
  current: StepRef | null;
  post: (message: WebviewMessage) => void;
  editor: UnitEditor | null;
  provider: { id: string; local: boolean } | null;
  onEdit: () => void;
  onToggle: () => void;
  onCallsEnter: (at: StepRef, anchor: Element) => void;
  onCallsLeave: () => void;
}

function UnitSection({ u, collapsed, current, post, editor, provider, onEdit, onToggle, onCallsEnter, onCallsLeave }: UnitProps) {
  const unit = editor?.shown ?? u.unit;
  const badge = unitBadge(u);
  const at = { unitId: unit.id };
  const isCurrent = current?.unitId === unit.id;
  const marks = editor ? changes(editor.base, editor.edits) : null;
  const classes = [
    "unit",
    `badge-${badge.kind}`,
    unit.lite ? "lite" : "",
    collapsed ? "collapsed" : "",
    isFaint(u) && !editor ? "faint" : "",
    isCurrent && !current?.stepId ? "current" : "",
    editor ? "has-edit" : "",
    editor?.editable ? "editing" : "",
  ];
  const field = (path: string, text: string, cls: string, tag: "p" | "dd") => <EditableText editor={editor} path={path} text={text} changed={marks?.set.has(path) ?? false} cls={cls} tag={tag} />;
  return (
    <section class={classes.filter(Boolean).join(" ")} data-key={unit.id} data-unit={unit.id}>
      <header class="unit-header" onMouseEnter={() => post({ type: "hover", at })}>
        <button class="twisty" aria-expanded={!collapsed} aria-label={collapsed ? "Expand" : "Collapse"} onClick={onToggle}>
          {collapsed ? "▸" : "▾"}
        </button>
        <a class="name" href="#" title="Show the code" onClick={(e) => (e.preventDefault(), post({ type: "showSource", at }))}>
          {displayName(unit.symbol)}
        </a>
        <span class="kind">{unit.kind}</span>
        <span class={`badge ${badge.kind}`} title={badge.title}>
          {badge.label}
        </span>
        {editor && (
          <span class="badge draft" title="A change to this unit is in progress. Its description shows the change as you wrote it, until it is applied.">
            {editor.edit ? stateLabel(editor.edit) : "Editing"}
          </span>
        )}
        {collapsed && <span class="one-line">{unit.summary}</span>}
        <span class="actions">
          {!editor && canEdit(u) && (
            <button class="secondary small edit-unit" title="Change what this unit does: edit its description, or ask for a change in your own words." onClick={onEdit}>
              Edit
            </button>
          )}
          {!editor && canVerify(u) && (
            <button class="secondary small verify" title="Mark this description as checked against the code." onClick={() => post({ type: "verify", unitId: unit.id })}>
              Verify
            </button>
          )}
        </span>
      </header>
      {!collapsed && (
        <div class="unit-body">
          {u.freshness !== "fresh" && (
            <div class="banner warning">
              {u.freshness === "code-changed" ? "Stale: the code changed after this was written. Highlighting shows the whole unit." : "This unit is no longer in the code."}
            </div>
          )}
          {field(fieldPath.summary, unit.summary, "summary", "p")}
          {(unit.inputs.length > 0 || unit.returns) && (
            <dl class="io">
              {unit.inputs.map((i) => (
                <div class="io-row" key={i.name}>
                  <dt>
                    <span class="io-name">{i.name}</span> <code>{i.type}</code>
                    {i.typeInferred && <span class="inferred" title="Type inferred by the compiler, not written in the code.">inferred</span>}
                  </dt>
                  {field(fieldPath.input(i.name), i.meaning, "", "dd")}
                </div>
              ))}
              {unit.returns && (
                <div class="io-row">
                  <dt>
                    <span class="io-name">returns</span> <code>{unit.returns.type}</code>
                    {unit.returns.typeInferred && <span class="inferred" title="Type inferred by the compiler, not written in the code.">inferred</span>}
                  </dt>
                  {field(fieldPath.returns, unit.returns.meaning, "", "dd")}
                </div>
              )}
            </dl>
          )}
          {unit.effects.length > 0 && <Effects effects={unit.effects} />}
          {editor?.editable && <NewStep editor={editor} place={{}} label="Add a first step" />}
          {unit.steps.length > 0 && (
            <ol class="steps">
              {unit.steps.map((s) => (
                <Step key={s.id} unitId={unit.id} step={s} current={current} post={post} editor={editor} added={marks?.added} onCallsEnter={onCallsEnter} onCallsLeave={onCallsLeave} />
              ))}
            </ol>
          )}
          {marks && marks.deleted.length > 0 && editor?.edit?.request.state !== "needs-review" && (
            <ul class="deleted-steps">
              {marks.deleted.map((s) => (
                <li key={s.id}>
                  <span class="mark removed">removed</span> <s>{s.text}</s>
                  {editor?.editable && (
                    <button class="link" title="Keep this step" onClick={() => editor.setEdits(revert(editor.base, editor.edits, { stepId: s.id }))}>
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unit.warnings.length > 0 && <Warnings warnings={unit.warnings} />}
          {editor && <EditPanel editor={editor} provider={provider} post={post} />}
        </div>
      )}
    </section>
  );
}

interface StepProps {
  unitId: string;
  step: SiftStep;
  current: StepRef | null;
  post: (message: WebviewMessage) => void;
  editor: UnitEditor | null;
  /** Steps the draft added (they have no code yet). */
  added: Set<string> | undefined;
  onCallsEnter: (at: StepRef, anchor: Element) => void;
  onCallsLeave: () => void;
}

function Step({ unitId, step, current, post, editor, added, onCallsEnter, onCallsLeave }: StepProps) {
  const at = { unitId, stepId: step.id };
  const isCurrent = current?.unitId === unitId && current.stepId === step.id;
  const path = fieldPath.step(step.id);
  const editable = editor?.editable === true;
  const isNew = added?.has(step.id) ?? false;
  const changed = isNew || (editor?.edits.some((e) => e.op === "set" && e.path === path) ?? false);
  const typing = editable && editor!.active !== null && "path" in editor!.active && editor!.active.path === path;
  const adding = editable && editor!.active !== null && "add" in editor!.active ? editor!.active.add : null;
  const classes = ["step", step.kind ? `kind-${step.kind}` : "", step.status ?? "", isCurrent ? "current" : "", changed ? "changed" : "", isNew ? "added" : ""];
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest?.(".calls, .step-actions, textarea")) return;
    if (e.ctrlKey || e.metaKey) post({ type: "navigate", at, source: false });
    else if (e.altKey) post({ type: "navigate", at, source: true });
    else if (editable) editor!.setActive({ path });
    else post({ type: "showSource", at });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.("textarea")) return;
    if (e.key === "F12") {
      e.preventDefault();
      post({ type: "navigate", at, source: e.altKey });
    } else if (e.key === "Enter") {
      if (editable) editor!.setActive({ path });
      else post({ type: "showSource", at });
    }
  };
  return (
    <li class={classes.filter(Boolean).join(" ")} data-key={stepKey(at)}>
      <div
        class="step-line"
        tabIndex={0}
        title={editable ? EDIT_HINT : step.calls.length > 0 ? NAV_HINT : undefined}
        onMouseEnter={() => !isNew && post({ type: "hover", at })}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {step.kind && <span class="step-kind">{step.kind}</span>}
        {typing ? (
          <InlineInput
            value={step.text}
            label="Step"
            onCommit={(text) => {
              editor!.setActive(null);
              editor!.setEdits(setText(editor!.base, editor!.edits, path, text));
            }}
            onCancel={() => editor!.setActive(null)}
          />
        ) : (
          <span class="text">{step.text}</span>
        )}
        {isNew && <span class="mark added" title="You added this step; the code does not do it yet.">new</span>}
        {!isNew && changed && <span class="mark changed" title="You changed this step; the code does not do it yet.">changed</span>}
        {!changed && step.status === "user-edited" && <span class="mark edited" title="A person wrote this step.">edited</span>}
        {step.status === "verified" && <span class="mark verified" title="A person checked this step.">✓</span>}
        {step.effects.length > 0 && <Effects effects={step.effects} small />}
        {step.calls.length > 0 && (
          <span
            class="calls"
            role="button"
            tabIndex={-1}
            aria-label={`${step.calls.length} call${step.calls.length === 1 ? "" : "s"}`}
            onMouseEnter={(e) => onCallsEnter(at, e.currentTarget as Element)}
            onMouseLeave={onCallsLeave}
            onClick={(e) => post({ type: "navigate", at, source: (e as MouseEvent).altKey })}
          >
            → {step.calls.length}
          </span>
        )}
        {editable && !typing && (
          <span class="step-actions">
            {changed && !isNew && (
              <button class="icon" title="Undo your change to this step" aria-label="Undo change" onClick={() => editor!.setEdits(revert(editor!.base, editor!.edits, { path }))}>
                ↺
              </button>
            )}
            <button class="icon" title="Add a step after this one" aria-label="Add a step after" onClick={() => editor!.setActive({ add: { after: step.id } })}>
              +
            </button>
            {step.kind && (
              <button class="icon" title={`Add a step inside this ${step.kind}`} aria-label="Add a step inside" onClick={() => editor!.setActive({ add: { parent: step.id } })}>
                ↳
              </button>
            )}
            <button class="icon" title="Remove this step" aria-label="Remove step" onClick={() => editor!.setEdits(removeStep(editor!.base, editor!.edits, step.id))}>
              ×
            </button>
          </span>
        )}
      </div>
      {adding?.parent === step.id && <NewStep editor={editor!} place={{ parent: step.id }} label="New step inside" nested />}
      {step.steps.length > 0 && (
        <ol class="steps">
          {step.steps.map((s) => (
            <Step key={s.id} unitId={unitId} step={s} current={current} post={post} editor={editor} added={added} onCallsEnter={onCallsEnter} onCallsLeave={onCallsLeave} />
          ))}
        </ol>
      )}
      {adding?.after === step.id && <NewStep editor={editor!} place={{ after: step.id }} label="New step" />}
    </li>
  );
}

/** A summary, input meaning, or returns meaning: click to edit while the unit is being edited. */
function EditableText({ editor, path, text, changed, cls, tag: Tag }: { editor: UnitEditor | null; path: string; text: string; changed: boolean; cls: string; tag: "p" | "dd" }) {
  const classes = (...more: string[]) => [cls, changed ? "changed" : "", ...more].filter(Boolean).join(" ") || undefined;
  if (!editor?.editable) return <Tag class={classes()}>{text}</Tag>;
  const typing = editor.active !== null && "path" in editor.active && editor.active.path === path;
  if (typing) {
    return (
      <Tag class={classes("editable-text")}>
        <InlineInput
          value={text}
          label={path}
          onCommit={(value) => {
            editor.setActive(null);
            editor.setEdits(setText(editor.base, editor.edits, path, value));
          }}
          onCancel={() => editor.setActive(null)}
        />
      </Tag>
    );
  }
  return (
    <Tag class={classes("editable-text")} data-path={path} tabIndex={0} title="Click to edit" onClick={() => editor.setActive({ path })} onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && editor.setActive({ path })}>
      {text}
      {changed && (
        <button
          class="icon"
          title="Undo your change"
          aria-label="Undo change"
          onClick={(e) => {
            e.stopPropagation();
            editor.setEdits(revert(editor.base, editor.edits, { path }));
          }}
        >
          ↺
        </button>
      )}
    </Tag>
  );
}

/** A new step being written, or (first in the unit) the button that starts one. */
function NewStep({ editor, place, label, nested }: { editor: UnitEditor; place: { after?: string; parent?: string }; label: string; nested?: boolean }) {
  const active = editor.active;
  const open = active !== null && "add" in active && active.add.after === place.after && active.add.parent === place.parent;
  if (!open) {
    if (place.after || place.parent) return null;
    return (
      <button class="link add-first" onClick={() => editor.setActive({ add: place })}>
        + {label}
      </button>
    );
  }
  const commit = (text: string) => {
    editor.setActive(null);
    if (text.trim() !== "") editor.setEdits(addStep(editor.base, editor.edits, place, text).edits);
  };
  return (
    <div class={nested ? "new-step nested" : "new-step"}>
      <InlineInput value="" label={label} placeholder="What should happen here, in plain words" onCommit={commit} onCancel={() => editor.setActive(null)} />
    </div>
  );
}

/** Plain-text editing in place: Enter keeps the text, Escape cancels, Shift+Enter starts a new line. */
export function InlineInput({ value, label, placeholder, onCommit, onCancel }: { value: string; label: string; placeholder?: string; onCommit: (text: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    fit(el);
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? value);
    else onCancel();
  };
  return (
    <textarea
      ref={ref}
      class="inline-input"
      aria-label={label}
      placeholder={placeholder}
      rows={1}
      defaultValue={value}
      onInput={(e) => fit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function stateLabel(edit: UnitEdit): string {
  if (edit.activity) return edit.activity === "checks" ? "Running checks…" : edit.activity === "applying" ? "Applying…" : "Proposing…";
  switch (edit.request.state) {
    case "draft":
      return "Draft";
    case "needs-answers":
      return "Questions";
    case "ready":
      return "Change ready";
    case "failed":
      return "Change failed";
    case "needs-review":
      return "Code changed";
    default:
      return "Proposing…";
  }
}

function Effects({ effects, small }: { effects: string[]; small?: boolean }) {
  return (
    <span class={small ? "effects small" : "effects"}>
      {effects.map((e) => (
        <span class={`chip effect-${e.split(".")[0]}`} key={e}>
          {e}
        </span>
      ))}
    </span>
  );
}

function Warnings({ warnings }: { warnings: SiftWarning[] }) {
  return (
    <aside class="warnings">
      {warnings.map((w) => (
        <div class={w.resolved ? "warning resolved" : "warning"} key={w.id}>
          <span class="warning-kind">{w.kind.replace(/-/g, " ")}</span> {w.text}
          {w.resolved && <span class="resolved-note"> Resolved by an edit: {w.resolved.note}</span>}
        </div>
      ))}
    </aside>
  );
}

function TargetCard({ card, post, onEnter, onLeave, onClose }: { card: Card; post: (m: WebviewMessage) => void; onEnter: () => void; onLeave: () => void; onClose: () => void }) {
  const open = (target: UnitTarget, e: MouseEvent) => {
    post({ type: "openTarget", target, source: e.altKey });
    onClose();
  };
  return (
    <div class={card.pinned ? "card pinned" : "card"} style={{ top: `${card.top}px`, left: `${card.left}px` }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog">
      {!card.targets && <p class="muted">Loading…</p>}
      {card.targets?.length === 0 && <p class="muted">No calls.</p>}
      {card.targets && card.targets.length > 0 && (
        <ul>
          {card.targets.map((t, i) => (
            <li key={`${t.ref}-${i}`} class={`target ${t.kind}`}>
              {t.kind === "unit" && (
                <>
                  <a href="#" onClick={(e) => (e.preventDefault(), open(t, e))} title="Click: open its logic · Alt+click: open its code">
                    {displayName(t.symbol)}
                  </a>
                  <span class="muted"> {t.file}</span>
                  <div class="target-summary">{t.summary}</div>
                </>
              )}
              {t.kind === "external" && (
                <>
                  <code>
                    {t.module}#{t.name}
                  </code>
                  <span class="muted"> library</span>
                  {t.effects.length > 0 ? <Effects effects={t.effects} small /> : <div class="target-summary muted">No known effects.</div>}
                </>
              )}
              {t.kind === "missing" && <span class="muted">A unit that has no description any more ({t.ref}).</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function cardPosition(anchor: Element | null | undefined, root: HTMLElement | null): { top: number; left: number } {
  if (!anchor || !root) return { top: 0, left: 0 };
  const a = anchor.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  return { top: a.bottom - r.top + 4, left: Math.max(0, Math.min(a.left - r.left, r.width - 320)) };
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
