import type { ExtractedUnit, StructureNode } from "./adapter.js";
import type { RuleSet } from "./rules.js";
import { EFFECTS, type Effect } from "./schema.js";

export interface UnitEffects {
  /** Union of every node's effects, in vocabulary order. */
  effects: Effect[];
  /** Effects of each structure node's own calls and statement (children not included), by node key. Nodes without effects are omitted. */
  nodes: Map<string, Effect[]>;
}

/**
 * Direct effects of a unit (design §9): from rule packs matching its call sites, `event.emit` from
 * emit edge rules, and `throws` from throw statements. Effects of called project units are not
 * included here; see `CodeGraph.effectsOf` for one-level propagation.
 */
export function effectsOfUnit(unit: ExtractedUnit, rules: RuleSet): UnitEffects {
  const nodes = new Map<string, Effect[]>();
  const all = new Set<Effect>();
  const visit = (node: StructureNode) => {
    const found = new Set<Effect>();
    if (node.kind === "throw") found.add("throws");
    for (const call of node.calls) {
      for (const e of rules.effectsFor(call)) found.add(e);
      if (rules.edgesFor(call).some((h) => h.rule.edge === "emits")) found.add("event.emit");
    }
    if (found.size > 0) {
      nodes.set(node.key, sortEffects(found));
      for (const e of found) all.add(e);
    }
    node.children.forEach(visit);
  };
  unit.body.forEach(visit);
  return { effects: sortEffects(all), nodes };
}

export function sortEffects(effects: Iterable<Effect>): Effect[] {
  const set = new Set(effects);
  return EFFECTS.filter((e) => set.has(e));
}

/**
 * Effects that make a unit worth a full description even if it is small: everything except `log`.
 * Core clears the adapter's lite flag when a unit has any of these (design §6.4).
 */
export function clearsLite(effects: readonly Effect[]): boolean {
  return effects.some((e) => e !== "log");
}
