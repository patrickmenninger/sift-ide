import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LogicUnit, NavTarget, SiftStep, SiftWarning } from "@sift/core";
import { canVerify, displayName, isFaint, needsUpdate, stepKey, unitBadge } from "./model.js";
import type { HostMessage, LogicDocumentState, StepRef, UnitTarget, WebviewMessage } from "./protocol.js";

/**
 * The logic document (phase-2-design §6.1): one continuous document per source file, each unit a
 * collapsible section with its status badge, summary, inputs and returns, effects, nested steps,
 * and warnings. It renders only what the host sends and answers with intents.
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

export function LogicDocument({ post, toggled: initialToggled = [], onToggled }: LogicDocumentProps) {
  const [state, setState] = useState<LogicDocumentState | null>(null);
  const [current, setCurrent] = useState<StepRef | null>(null);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set(initialToggled));
  const [card, setCard] = useState<Card | null>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; block: "start" | "nearest" } | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLElement>(null);
  const units = state?.file?.units ?? [];

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
        setCard((c) => (c && message.state.file?.units.some((u) => u.unit.id === c.at.unitId) ? c : null));
      } else if (message.type === "current") {
        setCurrent(message.at);
        if (message.at) setScrollTo({ key: stepKey(message.at), block: "nearest" });
      } else if (message.type === "reveal") {
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
    if (unit && isCollapsed(unit) && scrollTo.key !== unitId) {
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

interface UnitProps {
  u: LogicUnit;
  collapsed: boolean;
  current: StepRef | null;
  post: (message: WebviewMessage) => void;
  onToggle: () => void;
  onCallsEnter: (at: StepRef, anchor: Element) => void;
  onCallsLeave: () => void;
}

function UnitSection({ u, collapsed, current, post, onToggle, onCallsEnter, onCallsLeave }: UnitProps) {
  const { unit } = u;
  const badge = unitBadge(u);
  const at = { unitId: unit.id };
  const isCurrent = current?.unitId === unit.id;
  const classes = ["unit", `badge-${badge.kind}`, unit.lite ? "lite" : "", collapsed ? "collapsed" : "", isFaint(u) ? "faint" : "", isCurrent && !current?.stepId ? "current" : ""];
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
        {collapsed && <span class="one-line">{unit.summary}</span>}
        <span class="actions">
          {canVerify(u) && (
            <button class="secondary small" title="Mark this description as checked against the code." onClick={() => post({ type: "verify", unitId: unit.id })}>
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
          <p class="summary">{unit.summary}</p>
          {(unit.inputs.length > 0 || unit.returns) && (
            <dl class="io">
              {unit.inputs.map((i) => (
                <div class="io-row" key={i.name}>
                  <dt>
                    <span class="io-name">{i.name}</span> <code>{i.type}</code>
                    {i.typeInferred && <span class="inferred" title="Type inferred by the compiler, not written in the code.">inferred</span>}
                  </dt>
                  <dd>{i.meaning}</dd>
                </div>
              ))}
              {unit.returns && (
                <div class="io-row">
                  <dt>
                    <span class="io-name">returns</span> <code>{unit.returns.type}</code>
                    {unit.returns.typeInferred && <span class="inferred" title="Type inferred by the compiler, not written in the code.">inferred</span>}
                  </dt>
                  <dd>{unit.returns.meaning}</dd>
                </div>
              )}
            </dl>
          )}
          {unit.effects.length > 0 && <Effects effects={unit.effects} />}
          {unit.steps.length > 0 && (
            <ol class="steps">
              {unit.steps.map((s) => (
                <Step key={s.id} unitId={unit.id} step={s} current={current} post={post} onCallsEnter={onCallsEnter} onCallsLeave={onCallsLeave} />
              ))}
            </ol>
          )}
          {unit.warnings.length > 0 && <Warnings warnings={unit.warnings} />}
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
  onCallsEnter: (at: StepRef, anchor: Element) => void;
  onCallsLeave: () => void;
}

function Step({ unitId, step, current, post, onCallsEnter, onCallsLeave }: StepProps) {
  const at = { unitId, stepId: step.id };
  const isCurrent = current?.unitId === unitId && current.stepId === step.id;
  const classes = ["step", step.kind ? `kind-${step.kind}` : "", step.status ?? "", isCurrent ? "current" : ""];
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest?.(".calls")) return;
    if (e.ctrlKey || e.metaKey) post({ type: "navigate", at, source: false });
    else if (e.altKey) post({ type: "navigate", at, source: true });
    else post({ type: "showSource", at });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F12") {
      e.preventDefault();
      post({ type: "navigate", at, source: e.altKey });
    } else if (e.key === "Enter") {
      post({ type: "showSource", at });
    }
  };
  return (
    <li class={classes.filter(Boolean).join(" ")} data-key={stepKey(at)}>
      <div class="step-line" tabIndex={0} title={step.calls.length > 0 ? NAV_HINT : undefined} onMouseEnter={() => post({ type: "hover", at })} onClick={onClick} onKeyDown={onKeyDown}>
        {step.kind && <span class="step-kind">{step.kind}</span>}
        <span class="text">{step.text}</span>
        {step.status === "user-edited" && <span class="mark edited" title="A person wrote this step.">edited</span>}
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
      </div>
      {step.steps.length > 0 && (
        <ol class="steps">
          {step.steps.map((s) => (
            <Step key={s.id} unitId={unitId} step={s} current={current} post={post} onCallsEnter={onCallsEnter} onCallsLeave={onCallsLeave} />
          ))}
        </ol>
      )}
    </li>
  );
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
