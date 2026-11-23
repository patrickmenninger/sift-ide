import type { LogicFile, LogicUnit } from "@sift/core";
import type { StepRef } from "./protocol.js";

/**
 * What the logic document shows for each unit's status (phase-2-design §6.4). DOM-free so it can
 * be tested on its own.
 */
export type BadgeKind = "stale" | "generated" | "user-edited" | "verified";

export interface Badge {
  kind: BadgeKind;
  label: string;
  title: string;
}

export function unitBadge(u: LogicUnit): Badge {
  if (u.freshness === "code-changed") return { kind: "stale", label: "Stale", title: "The code changed after this was written. Update the description before relying on it." };
  if (u.freshness === "not-in-code") return { kind: "stale", label: "Not in code", title: "This unit is no longer in the code." };
  if (u.status === "stale") return { kind: "stale", label: "Needs review", title: "Sift could not keep this description current on its own (a person's wording changed, or the update found a problem). Review it." };
  if (u.status === "user-edited") return { kind: "user-edited", label: "Edited", title: "A person wrote parts of this description." };
  if (u.status === "verified") return { kind: "verified", label: "Verified", title: "A person checked this description against the code." };
  const by = u.unit.generatedBy;
  return { kind: "generated", label: "Unverified", title: `Written by AI${by ? ` (${by.model})` : ""} and not checked by a person yet.` };
}

/** Verifying vouches for the text against the current code, so only fresh, unflagged units qualify. */
export function canVerify(u: LogicUnit): boolean {
  return u.freshness === "fresh" && u.status !== "stale" && u.status !== "verified";
}

/** Generated text is drawn faint until a person verifies or writes it (requirements §3.8). */
export function isFaint(u: LogicUnit): boolean {
  return unitBadge(u).kind === "generated";
}

/** Whether the file has anything a generate run would change: missing or out-of-date units. */
export function needsUpdate(file: LogicFile): boolean {
  return file.undescribed.length > 0 || file.units.some((u) => u.freshness !== "fresh" || u.status === "stale");
}

export function stepKey(at: StepRef): string {
  return at.stepId ? `${at.unitId}/${at.stepId}` : at.unitId;
}

/** The short name shown for a unit: methods keep their class. */
export function displayName(symbol: string): string {
  return symbol === "<module>" ? "Top-level code" : symbol;
}
