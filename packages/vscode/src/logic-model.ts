import type { NavTarget } from "@sift/core";
import type { UnitTarget } from "./webview/protocol.js";

/** Where Ctrl+click on a step goes (phase-2-design §6.3). No `vscode` here, so it can be tested. */
export type NavPlan =
  /** One unit in the project, or one described implementation of an interface member. */
  | { kind: "open"; target: UnitTarget }
  /** Several units: implementations of an interface member, or a step with several calls. */
  | { kind: "pick"; targets: UnitTarget[] }
  /** Only library calls: nothing to open, show what they are. */
  | { kind: "card" }
  | { kind: "none"; message: string };

export function planNavigation(targets: NavTarget[]): NavPlan {
  const units: UnitTarget[] = [];
  for (const t of targets) if (t.kind === "unit" && !units.some((u) => u.unitId === t.unitId)) units.push(t);
  if (units.length === 1) return { kind: "open", target: units[0]! };
  if (units.length > 1) return { kind: "pick", targets: units };
  if (targets.some((t) => t.kind === "external")) return { kind: "card" };
  if (targets.length > 0) return { kind: "none", message: "The unit this step calls has no description any more. Update the descriptions to follow it." };
  return { kind: "none", message: "This step calls nothing Sift can follow." };
}

/** The source file a `.sift` file describes (`.sift/src/a.ts.sift` → `src/a.ts`), or null for other paths. */
export function sourceOfLogic(projectRelative: string): string | null {
  const m = /^\.sift\/(.+)\.sift$/.exec(projectRelative.replace(/\\/g, "/"));
  if (!m || m[1]!.startsWith(".cache/")) return null;
  return m[1]!;
}

/** The `.sift` file for a source file, project-relative. */
export function logicOfSource(source: string): string {
  return `.sift/${source}.sift`;
}
