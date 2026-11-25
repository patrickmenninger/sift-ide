# Sift — Phase 2 Design: MCP Server, VS Code Extension, Natural-Language Editing

Status: released in 0.2.0 (M9–M17) · Scope: Phase 2 of [requirements.md](../requirements.md) · Builds on [design.md](design.md) (Phase 1)

## 1. Scope

Phase 2 puts the Phase 1 engine in front of two audiences: AI coding agents (through an MCP server) and developers (through a VS Code extension), and adds the reverse direction — natural-language edits that become reviewed source changes.

In scope (requirements §13, Phase 2):

- A long-running **workspace service** in core that the CLI, the MCP server, and the extension all share.
- **MCP server** (`sift mcp`) exposing descriptions, status, the code graph, flows, and impact analysis.
- **VS Code extension**: logic document, source side by side with step ↔ source highlighting, status badges, step navigation (Ctrl+click) with an implementation picker, focused graph views (neighbourhood, flow from a route, impact of a change).
- **Natural-language editing**: edits as change requests, clarifying questions and warnings, targeted code changes, scope checks against the graph, type-check validation, review (source diff + logic diff + checks), approval, undo, and pending-edit handling when code moves underneath.
- **Schema v1** for step-level provenance, with migration from v0.
- Evaluation of editing, added to the harness.
- `flow(route)` query (deferred from Phase 1 §10.4).

Out of scope: test association and test-failure mapping (Phase 3; the validation step runs only configured commands, §8.6), Python and the generic adapter, marketplace publishing and signed builds (Phase 4), the Code-OSS fork, configurable autonomy (every code change needs approval), bring-your-own-key providers (a separate track; nothing here depends on them), MCP tools that change code.

## 2. Starting Point, Branches, and Release

Phase 1 is on `main` (M1–M8). The `reduce-token-usage` branch (per-file batching, Sonnet routing) is finished but not merged.

**Before M9:**

1. Merge `reduce-token-usage` into `main`, bump every workspace package to `0.1.0`, add `CHANGELOG.md`, tag `v0.1.0` (Phase 1).
2. Create `develop` from `main`.

**During Phase 2:**

- Each milestone is a branch off `develop` (`m9-workspace`, `m10-mcp`, …), merged back into `develop` with `--no-ff` once `npm run verify` passes. Milestones that run in parallel (§12) each get their own branch.
- `main` is not touched during the phase.
- Commits carry no AI co-author trailers.

**End of Phase 2 (M17):** bump all packages to `0.2.0`, update `CHANGELOG.md` and the README, build the `.vsix`, merge `develop` into `main` with `--no-ff`, tag `v0.2.0`.

## 3. Architecture

```text
 ┌──────────────┐   ┌───────────────────┐   ┌─────────────────────────────────┐
 │     cli      │   │    mcp-server     │   │        vscode extension          │
 │ (one-shot)   │   │  (stdio, agents)  │   │  extension host  │   webviews    │
 └──────┬───────┘   └─────────┬─────────┘   └────────┬─────────┴──────┬────────┘
        │                     │                      │ JSON-RPC        │ postMessage
        │                     │                      ▼ (stdio)         │
        │                     │             ┌──────────────────┐       │
        │                     │             │   sift serve     │◄──────┘ (via host)
        │                     │             └────────┬─────────┘
        ▼                     ▼                      ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ core: Workspace (§4) · queries · generate · sync · edit pipeline (§8)       │
 └──────────────┬───────────────────────────────────────────┬──────────────────┘
                │ LanguageAdapter (+ overlays, §8.5)         │ Provider
       adapter-typescript                          provider-claude-code
```

- The Phase 1 rule stands: core never imports the TypeScript compiler and never spawns `claude`.
- **The engine runs out of the extension host.** The TypeScript program for a real project is large and building it blocks for seconds; requirements §10.2 forbids blocking the editor. The extension spawns `sift serve` (the same bundled engine) as a child Node process and talks JSON-RPC over stdio (`vscode-jsonrpc`). One server per workspace folder.
- **The MCP server** is a separate stdio process (`sift mcp`) holding its own `Workspace`. Agents and the extension never share a process.
- The CLI keeps its one-shot behaviour, but every command goes through `Workspace` so there is one code path.

### 3.1 New Packages

```text
packages/
├── server/          # @sift/server: JSON-RPC protocol types + `sift serve`
├── mcp-server/      # @sift/mcp: MCP tools over Workspace, `sift mcp`
└── vscode/          # sift-vscode: extension (host code + webview UI)
```

New libraries, each for a reason: `vscode-jsonrpc` (protocol with cancellation, used by VS Code itself), `@modelcontextprotocol/sdk` (MCP transport and schema), `esbuild` (bundling extension, server, and webviews into the `.vsix`), `@vscode/test-electron` (integration tests), `preact` (webview UI: small, no build-time framework), `elkjs` (layered graph layout for §6.5). No others without a reason.

The extension bundles the engine and the pinned `typescript` 6.0.x; it never uses the project's own TypeScript (TS 7 has no compiler API, design §2.1).

## 4. Workspace Service

`core/workspace.ts` turns today's per-command setup into a long-lived object.

```ts
class Workspace {
  static open(root: string, opts: WorkspaceOptions): Promise<Workspace>;

  // Freshness: called on file-watcher events or before a query.
  refresh(changed?: string[]): Promise<RefreshResult>;     // fast path §5.1, graph §10.2
  onDidChange(listener: (e: WorkspaceChange) => void): Disposable;

  // Reading (no AI)
  file(path: string): Promise<LogicFile>;                    // .sift + status + ranges
  unit(ref: UnitRef): Promise<LogicUnit>;
  status(paths?: string[]): Promise<StatusReport>;           // §7.2.1
  find(query: string): QueryHit[];
  callers(ref, depth) / callees(ref, depth) / impact(refs | { diff: string }) / flow(route);
  sourceRanges(unitId: string, stepId?: string): SourceRange[];
  stepAt(path: string, pos: Position): { unitId: string; stepId?: string } | null;
  resolveStepCall(unitId: string, stepId: string): NavTarget[]; // §6.3

  // Writing
  generate(opts: GenerateOptions): Promise<GenerateReport>;  // existing pipeline
  verify(unitIds: string[]): Promise<void>;                  // status → verified (§7)
  edits: EditService;                                        // §8

  dispose(): void;
}
```

- **The adapter project stays open.** `refresh` re-extracts only changed files and their dependants (design §10.2); the slow `openProject` happens once per session and again only when `tsconfig`/`package.json` change.
- **Ranges.** `sourceRanges` maps a step's `covers` keys to ranges through the cached extraction, valid only while the unit's `bodyHash` matches; otherwise the result says the unit is stale and returns the unit's range alone.
- **Concurrency.** One write operation (generate, apply edit) at a time per workspace, queued; reads are never blocked by AI calls. Long operations take an `AbortSignal` and report progress events.
- **Saved files only.** The engine reads disk. When an editor buffer is dirty, the extension shows "source has unsaved changes" on the logic document instead of describing unsaved code.

**As built (M9)**, `core/workspace.ts`:

- `Workspace.open({ cwd, adapters, builtinRulesDir, provider? })` loads the config and rule packs once. `provider` may be a function of the config, since the config names the provider.
- Every query refreshes through the existing fast path and cached extractions; the adapter's program is opened only when a file must be re-extracted, as in Phase 1. Keeping a TypeScript program open between requests is deferred to M14, where the overlays for edit validation (§8.10) need an incremental program anyway; until then a refresh after an edit costs one program build, as `sift` commands do today. (Done in M14: see §8.12.)
- Operations run one at a time (`serial`), so two refreshes never write the cache at once.
- `.sift` files are read through a cache keyed by size and mtime, so a long-running server rereads only files that changed (including changes from git).
- Beyond the methods above: `readSift`, `extraction`, `unitIndex`, `findRoutes`, `router`, and `migrate`. `verify` refuses units that are changed, renamed, stale, or whose callees' summaries changed. It clears step-level `verified` (the unit now covers them) and keeps `user-edited` steps, because verification and authorship are separate facts.
- `LogicUnit.freshness` compares the description's `bodyHash` with the code; callee-summary drift is reported by `status`, not per unit.
- `stepAt` picks the innermost unit containing the position, then the deepest structure node, then the step that owns it (the same ownership rule as `calls`, `describe-output.ts#stepOwners`). A position in a unit's signature returns the unit with no step.
- `stepTargets` maps `calls` in order. An interface call already lists every described implementation (design §8), so the picker gets them without another lookup. Library targets carry the rule-pack effects for that member.
- The CLI now runs every command through `Workspace` and gains `sift flow`, `sift verify`, `sift migrate`, and `sift serve`.

### 4.1 `sift serve` Protocol

JSON-RPC requests mirror the `Workspace` methods (`sift/file`, `sift/callers`, `sift/edit/propose`, …); notifications carry `WorkspaceChange`, progress, and pending-edit state. Protocol types live in `@sift/server` and are imported by the extension, so the two cannot drift. Every request carries a `protocolVersion`; a mismatch is a clear error, not a misread.

**As built (M9)**, `packages/server` (protocol version 1, `vscode-jsonrpc` 9.0.3):

- The client calls `sift/initialize` with its `protocolVersion` first; any other request before it, or a version mismatch, is refused.
- Requests: `sift/refresh`, `sift/logicFile`, `sift/unit`, `sift/extraction`, `sift/status`, `sift/callers`, `sift/callees`, `sift/impact`, `sift/routes`, `sift/flow`, `sift/sourceRanges`, `sift/stepAt`, `sift/stepTargets`, `sift/generate`, `sift/verify`. The `Requests` map in `protocol.ts` types each one's params and result.
- Notifications: `sift/didChange` (`{ type: "source" | "descriptions", files }`) and `sift/generateProgress` (`{ token, event }`, for a `sift/generate` that passed a `token`).
- Sift errors use JSON-RPC code `-32001`, with `data: { code, details }`; `SiftClient` turns them back into `SiftError`.
- `sift serve` writes only protocol messages to stdout; it logs to stderr.
- Not yet: edit methods (M14). (Added in M14, §8.12.)

**M11 additions:** cancelling a `sift/generate` request (`$/cancelRequest`) aborts an `AbortSignal` passed to `generate`. No AI call starts after that, running ones are cancelled through the provider's `signal`, and calls cut short are not counted as failures. Units already described are written; the rest keep their previous descriptions (and the file's `fileHash` stays old, so status still lists them); the report has `cancelled: true`. `sift/initialize` also returns `provider: { id, local } | null`, which the extension uses to say where code goes. Both changes are additive, so the protocol version stays 1.

## 5. MCP Server

`sift mcp [--root <dir>] [--allow-generate]`, stdio transport. Setup for Claude Code is one line in the README:

```bash
claude mcp add sift -- npx sift mcp
```

**Tools** (all read-only unless noted; all return compact JSON plus a short text rendering):

| Tool | Returns |
|---|---|
| `sift_describe` | One unit or a whole file's logic: summary, inputs, returns, nested steps with call targets, effects, warnings, status. |
| `sift_find` | Units matching a name, with file, kind, and one-line summary. |
| `sift_callers` / `sift_callees` | As the CLI (design §10.4), with edge confidence and possible gaps. |
| `sift_impact` | For symbols or a git ref (`{ diff: "HEAD" }`): affected units and routes, weakest confidence per path. |
| `sift_flow` | Units reachable from a route handler, with effects at each step. |
| `sift_status` | Out-of-date descriptions (§7.2.1). |
| `sift_generate` | Only with `--allow-generate`: runs `generate` for given paths. Off by default because it spends the user's AI quota. |

Rules:

- **Status travels with the text.** Every description returned carries its status, and a stale unit's text is prefixed "Stale: the code changed after this was written" (requirements §8.9). An agent must never get a stale description that looks current.
- The server refreshes (fast path) before each call, so results reflect the agent's own edits.
- Responses are bounded (default depth 2, at most 50 results, with a "truncated" note) so a large codebase does not flood the agent's context.
- Resources: `sift://file/<path>` for each described file, so clients that browse resources can attach logic documents directly.
- No tool edits code. Agents already do that; Sift's job here is to tell them what their change touches.

**As built (M10)**, `packages/mcp-server` (`@sift/mcp`, `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 for tool schemas):

- `createMcpServer({ workspace, allowGenerate, version })` registers the tools; `serveMcp` runs it on stdio until stdin ends. `sift mcp` opens the workspace with a provider only when `--allow-generate` is given. Setup in the README is `claude mcp add sift -- sift mcp`, since Sift is not on npm yet (`npx` arrives with publishing, Phase 4).
- Each tool returns a text rendering in `content` and the compact JSON in `structuredContent`. Neither has hashes, structure keys, or provenance. Calls are shown as `file#Symbol`, never unit IDs. Read-only tools carry `readOnlyHint`. The server's `instructions` tell the agent when to describe, when to check impact, and what "Stale:" means.
- **Stale marking.** A unit is stale when its code changed (`freshness: code-changed`), when its code is gone (`not-in-code`), or when its status is `stale`. Each case has its own sentence starting with "Stale:". The sentence is set as `stale` and also starts `summary`, in the JSON and in the text, in `sift_describe`, `sift_find`, and the resources. Callee-summary drift (`contextChanged`) is reported only by `sift_status`, as in §4.
- **Bounds.** Every list holds at most 50 items. `truncated` counts what each list left out, and the text says so. `sift_callers`/`sift_callees` default to depth 2 (maximum 10). `sift_flow` defaults to depth 10 (maximum 20): a route needs more than two levels to reach the database, and the 50-item cap still holds.
- Beyond the table: `sift_describe` accepts a path, `file#Symbol`, a name, or a `u_` ID. `sift_find` falls back to a case-insensitive substring match when no name matches exactly. `sift_flow` without a route lists the routes. Sift errors (unknown symbol, no description yet) come back as tool errors (`isError`) with the same message and details as the CLI.
- Core gained `Workspace.logicFiles(sources)`: several files' logic with one refresh, so `sift_find` does not refresh once per file.

## 6. VS Code Extension

Activation: a workspace containing `.sift/` or `sift.config.yaml`. Without one, the command palette offers "Sift: Initialize".

### 6.1 Logic Document

A custom editor (`CustomTextEditorProvider`) registered for `*.sift` files, and a command **Sift: Open Logic** (editor title button and `Ctrl+Alt+L`) that opens the logic document for the current source file beside it.

- One continuous document per source file. Each unit is a collapsible section: name and kind, status badge, summary, inputs and returns (type in code font, meaning in prose; inferred types marked), effects as chips, the nested step outline, then warnings in a visually separate block.
- Lite units collapse to one line.
- Rendered in a webview (Preact), styled from VS Code theme variables so it follows light, dark, and high-contrast themes.
- The webview never reads files; it receives a `LogicFile` from the host and sends back intents (navigate, edit, verify).

### 6.2 Source Side by Side

- Hovering a step highlights its source ranges in the source editor (`TextEditorDecorationType`); several ranges for one step, and ranges shared by several steps, are both supported (requirements §4.6).
- Moving the cursor in the source highlights the step that owns that position (`Workspace.stepAt`), and scrolls the logic document if the unit is collapsed off screen.
- Ranges come from the cache and are only shown when the unit is fresh. For a stale unit, the whole unit is outlined and the badge says so.

### 6.3 Step Navigation

- **Ctrl+click on a step** (or F12 with the step focused) follows `step.calls`:
  - one project unit → opens that unit's logic, scrolled to it;
  - an interface member with one described implementation → straight to it;
  - several implementations → QuickPick listing each with its one-line summary (Go to Implementation);
  - external call → hover card showing `module#name` and the rule-pack effects; no navigation.
- **Alt+click** (secondary action) opens the callee's source instead.
- Back/forward uses VS Code's navigation history (`workbench.action.navigateBack`), so it behaves like code navigation.
- A step with several calls shows a small menu of targets.
- Call targets come only from `calls`, which core derives from the compiler (design §6.2); the extension never guesses.

### 6.4 Status and Sync

- Badges per unit: generated (unverified), user-edited, verified, stale; the requirement that unverified text is always visibly unverified (§3.8) is met by the badge and by a faint style on generated text until verified.
- **Verify**: a button per unit marks it `verified` (writes the `.sift` file). Verifying a stale unit is not offered.
- Status bar item: count of out-of-date units; click opens a Problems-style list (tree view) from `status`.
- Explorer decorations: a dot on source files whose logic is stale or missing.
- **Generating** is always an explicit action ("Describe this file", "Update stale units") with a cost estimate from `--dry-run` before it starts. A setting `sift.updateOnSave` (`off` | `ask`, default `off`) can prompt after saves. No silent AI calls.

### 6.5 Graph Views

Focused views only (requirements §3.9), each in its own webview panel or tree view:

| View | Content | Form |
|---|---|---|
| Callers / Callees | Tree, expandable depth, edge confidence as icon, gaps listed at the end | Native tree view in the Sift sidebar |
| Neighbourhood | The unit, its direct callers and callees, implementations, routes, events | Diagram (elkjs layered layout, SVG) |
| Flow | From a route handler down through services and repositories to effects | Diagram, top to bottom, effects as chips on nodes |
| Impact | For the current git diff, or a pending edit: affected units and routes, grouped, with weakest confidence per path | Tree + optional diagram |

Every node opens its logic on click (Alt+click: source). Edges drawn dashed for `name-match` and `rule`, so weaker connections are visible. Gaps are shown as "possible callers not resolved" nodes rather than hidden.

### 6.6 As Built (M11): Extension Shell

`packages/vscode` (`sift-vscode`; `esbuild` 0.28.2, `@vscode/vsce` 4.1.1, `@vscode/test-electron` 3.1.0; engine `^1.100.0`):

- **Packaging.** `scripts/build.mjs` bundles from package sources (no `tsc -b` needed): `dist/extension.cjs` (CommonJS, `vscode` external) and `dist/server.mjs` (ESM: core, the TypeScript adapter, the claude-code provider, `@sift/server`, and `typescript` 6.0.3). Core finds its prompts and model maps at `../prompts` and `../models` relative to the bundle, so the build copies them to the extension root, with the rule packs as `rules/`. `typescript` locates its `lib.*.d.ts` next to `__filename`, so the server banner defines `require`, `__filename`, and `__dirname`, and the build copies the lib files into `dist/`. The extension bundle aliases `@sift/core` to `src/core-runtime.ts` (only `SiftError`): core reads files at load time, which must happen only in the server. `npm run package:vscode` minifies and writes `sift.vsix` (about 1.7 MB).
- **Server lifecycle** (`server-process.ts`). One `sift serve` per workspace folder whose root holds `sift.config.yaml`, spawned on VS Code's own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`) as `server.mjs serve <root>`. It starts on activation, and on demand for a request. A crash after initialization is restarted with backoff (n seconds), at most three times in three minutes; then the state is `failed` until **Sift: Restart Server**. A failure before initialization (no config, protocol mismatch) is not retried, and its message includes the server's last stderr lines. Notification listeners survive restarts. Stopping closes stdin and kills after 2 s.
- **Status** (`project.ts`, `status-model.ts`). Each project keeps the last `sift/status`. A file watcher on source, `.sift`, and config files schedules a refresh (debounced 400 ms; overlapping refreshes run once more, not once each), as does a `sift/didChange` of type `descriptions` (`source` changes come from refreshes the extension itself asked for, so they are ignored). The status bar sums projects; the **Out of Date** tree groups units by reason (stale, changed, new, renamed, ambiguous, callees changed, deleted, unreadable); explorer decorations mark files with any non-deleted entry, in a separate colour when every entry is "new" (not described yet rather than out of date).
- **Callers / Callees views.** The unit at the cursor is found from the file's extraction (innermost non-module unit, else the module unit), so it works for undescribed code too. Each level is one `sift/callers`/`sift/callees` request at depth 1, expanded lazily; routes and events are leaves. Icons show edge confidence (`resolved` and `language-server` filled/outlined checks, `rule` a ruler, `name-match`/`inferred` a question mark); callees list propagated effects first; gaps are a collapsed group at the end. Clicking a unit opens its source; the inline action opens the call site.
- **Generating.** Describe This File / Describe Folder / Update Out-of-Date (and the inline action on Out of Date groups and entries) run a dry run first and show a modal: units by task and model, possible context checks, renames and deletions done without AI, and where the code is sent. Sift has no price table, so the estimate is in units and models, not money. Renames and deletions with no AI work still ask before writing. The run shows per-unit progress and is cancellable; one run at a time. `sift.updateOnSave: ask` offers an update after a save that leaves the file out of date; "Not now" holds until the file's logic is current again.
- **Sift: Initialize** runs `server.mjs init <folder>` and starts the server.
- **Tests.** vitest covers the vscode-free modules against an in-process server (`test-support.ts`: a fake child process over in-memory pipes): lifecycle, crash restarts and giving up, start failures, status coalescing, the dry-run summary. `npm run test:vscode` runs `test/integration.cjs` in a downloaded VS Code on a fixture copy: activation, status, a new file appearing, Show Callers/Callees, command registration, restart. It is not part of `npm run verify` (it opens a window and downloads VS Code); CI runs it on Windows, macOS, and Linux (`.github/workflows/ci.yml`, M17), under `xvfb-run` on Linux.
- Limits found along the way are listed in [extension-limits.md](extension-limits.md).

### 6.7 As Built (M12): Logic Document

`preact` 11.2.0 for the webview, `jsdom` 31.0.0 for its tests. No protocol change: everything below uses the M9 requests.

- **Two ways in, one document** (`logic-editor.ts`). A `CustomTextEditorProvider` (`sift.logic`, default for `*.sift`) shows a `.sift` file as its source's logic. **Sift: Open Logic** (`Ctrl+Alt+L`, editor title, editor and explorer context menus) opens that editor beside the source, keeping focus in the code; a source file with no `.sift` file yet gets a webview panel with the same document (a custom editor needs a file), which lists the undescribed units and offers **Describe this file…**. An open document for the file is reused. **Sift: Open Source** goes the other way.
- **Webview** (`src/webview/`, bundled by esbuild as `dist/webview.js` and `webview.css`, loaded under a nonce CSP with `localResourceRoots` limited to `dist/`). `protocol.ts` types the messages both ways; the webview gets `{ source, file: LogicFile, error, dirty }` and sends intents (`hover`, `showSource`, `navigate`, `targets`, `openTarget`, `verify`, `describe`). It reloads the file after every status refresh, since any refresh can change freshness. Collapsed sections survive reloads through the webview's own state; lite units start collapsed to one line.
- **Badges** (`model.ts`): Unverified (generated), Edited, Verified, Stale (code changed), Not in code, Needs review (`status: stale`). Unverified text is drawn at reduced opacity, except steps a person wrote. **Verify** appears only on fresh units that are not stale or verified already, and calls `sift/verify`; a refusal (for example callees' summaries changed) is shown with its reason.
- **Logic → source.** Hovering a step requests `sift/sourceRanges` (cached per document until its next reload) and decorates every visible editor of the source: steps with the strong word-highlight background, a hovered unit with a margin line, a stale unit with a dashed warning margin over the whole unit. Clicking a step shows its code beside the document, selected, with focus kept in the document.
- **Source → logic.** Cursor moves in a source editor (debounced 120 ms) ask `sift/stepAt`; the document marks the step, opens its unit if collapsed, and scrolls it into view. While the source buffer has unsaved changes the document shows "The source has unsaved changes. This describes the saved file." and marks no step, since positions in the buffer may not match the saved file.
- **Navigation** (`logic-model.ts#planNavigation`). Ctrl+click (Cmd on macOS) or F12 asks `sift/stepTargets`: one project unit opens its logic (same column, so Go Back returns); several (an interface member's implementations, or several calls) give a QuickPick with each one's summary; only library calls pin the calls card; a missing callee says so in the status bar. Alt+click (Alt+F12) opens the callee's code instead. Hovering the `→ n` after a step shows the card: project targets with their summaries (click to open, Alt+click for code) and library calls as `module#name` with their rule-pack effects.
- **Tests.** vitest renders the document in jsdom from hand-built `LogicFile`s (badges, faint text, Verify, intents for click/Ctrl/Alt/F12, lite collapse, cursor marking, the calls card, unsaved and error banners), and checks `planNavigation` against the fixture: both `AccountRepository` implementations go to the picker, Prisma-only steps to the card. The integration tests (`run-integration.mjs` now describes `src/accounts` with the stand-in model first, so it needs `npm run build`) open the logic editor and check the webview script loaded, cursor → step, step ranges, the picker opening the chosen implementation and Go Back, the pinned card, Alt+click, Verify writing the file, the unsaved-changes flag and staleness after saving, and the panel for an undescribed file.

### 6.8 As Built (M13): Graph Views

`elkjs` 0.12.1 (`lib/elk.bundled.js`, layout in the webview's own thread). No protocol change: the views use `sift/callers`, `sift/callees`, `sift/flow`, `sift/impact`, `sift/routes`, and `sift/extraction`.

- **Model on the host, drawing in the webview.** `graph-model.ts` (no `vscode`) turns query results into a `GraphModel` of nodes (unit, declaration, external, route, event, gaps) and edges (calls, implements, handles-route, emits, listens, possible). A call through an interface member is drawn caller → member → implementation; a call through an event, emitter → event → listener. Project nodes that are not units in their file's extraction (a class called as a constructor, an interface member) become declarations, which open code rather than logic. The webview (`src/webview/graph-view.tsx`, bundled as `dist/graph.js`/`graph.css`) measures labels with a canvas in the editor's fonts, lays out with elkjs (layered, top to bottom, orthogonal edges, model order kept so a refresh does not reshuffle), and draws SVG.
- **Neighbourhood** (**Show Neighbourhood Diagram**, editor context menu, Callers/Callees tree items): depth-1 callers above, callees below; routes the unit handles; the subject's effects (with those of its direct callees) as chips; possible callers and unresolved calls as one gaps node each, listing up to six sites, each clickable.
- **Flow** (**Show Route Flow…**, a QuickPick of `sift/routes`; also by clicking any route node): route → handlers (an inline callback is marked) → everything reached, with each unit's direct effects and each library call's rule-pack effects as chips.
- **Impact** (**Show Impact of Changing This** for the unit at the cursor; **Show Impact of Uncommitted Changes**, `diff: "HEAD"`): a list grouped as Changed, Routes reached, Direct callers, *n* calls away, and Possible callers not resolved, with a confidence badge where the path's weakest link is not `resolved`; the diagram is a toggle kept in webview state. `ImpactResult` gives only the weakest confidence per path, so an edge is dashed where the path weakens (the node's confidence is weaker than its predecessor's); nodes on a weak path get a dashed outline.
- **Edges** are dashed for `rule`, `name-match`, and `inferred`, and for edges to or from gaps nodes; `implements` edges use the interface colour.
- **Interaction.** Click: a unit opens its logic, scrolled to it (or the file's logic panel when it is not described yet), a declaration its code, a route its flow, an event its registration. Alt+click opens a unit's code; Shift+click shows its neighbourhood. Nodes are focusable and open with Enter. Zoom out/in, Fit, and 100%.
- **Panels** (`graph-panels.ts`). One webview panel per view kind, reused for the next query of that kind. A panel reruns its query whenever the project's status refreshes (so the impact of uncommitted changes follows saves), says when files in the project have unsaved changes, and has Refresh. The webview reports `drawn` (node count, or the layout error, which is logged).
- **Tests.** vitest builds models from hand-made results (events, routes, gaps, weak edges, dispatch in impact) and against the fixture: the `transferFunds` neighbourhood reaches both `AccountRepository.save` implementations through the member; the flow of each Express route reaches the Prisma calls with `db.*` effects (§11); the impact of an uncommitted change to `PrismaAccountRepository.save` reaches `POST /transfers` over a dashed rule edge. jsdom tests run the real elkjs layout (no overlaps, callers above, callees below) and the view (dashed edges, chips, gap lines, click/Alt/Shift/Enter intents, impact grouping and the diagram toggle, banners). Integration tests open each view from its command, check the webview drew it, open a node's logic, Shift+click to recentre, and click a route in the impact view to open its flow.
- Limit found: no diagram view in the extension API ([extension-limits.md](extension-limits.md) #7).

## 7. Schema v1

Editing needs provenance below the unit level: "Distinguish user-specified behaviour from AI-proposed behaviour" (requirements §11.1), and user wording must survive later updates.

Changes from v0:

| Field | Change |
|---|---|
| `sift` | `1`. |
| `steps[].status` | New, optional: `user-edited` or `verified`. Omitted means "as the unit". |
| `summary`/`inputs[].meaning`/`returns.meaning` | A unit-level `userEdited: [summary, inputs.amount, returns]` list names the non-step fields written by a person. |
| `warnings[].resolved` | New, optional: `{ by: "edit", note }` when a warning was answered by an edit (§8.4); resolved warnings are dropped on the next update that no longer finds the problem. |

- **Reading:** v0 and v1 are both accepted; v0 maps directly (no new fields). The declared version is kept, and a file that declares 0 but holds v1 fields is invalid (hand-edited, or written by a confused tool).
- **Writing:** a file keeps `sift: 0` until something writes a v1-only field into it; then that one file is upgraded (`requiredSchemaVersion`, applied by the serializer). New files are written at the current version. `sift migrate` upgrades every file at once for teams that prefer one commit. This keeps the byte-stable rewrite rule (design §6.3): no file changes just because Sift was upgraded, and a migration changes only the header line.
- **Update and context-check prompts** mark user-edited steps and fields individually (today: the whole unit). A user-edited step whose code did not change is never reworded; one whose code changed is updated only if it became wrong, and then the unit goes `stale` for review as before.
- **Unit status** becomes derived for display: `stale` if any part is stale, else `user-edited` if any field is, else as stored.

**As built (M9)**, `core/provenance.ts`:

- A unit with `status: user-edited` and no `userEdited` or step statuses is a v0 unit: all its wording is the person's, as before.
- After an **update** (code changed), user-edited steps and fields carry over while their text is unchanged; step-level `verified` is dropped. If a person's piece was reworded, or the unit came back stale, the unit is written `stale` and listed for review.
- After a **context check** (code unchanged), reworded steps lose their status, untouched ones keep it (including `verified`), and the unit goes to review only if a person's piece was reworded. A verified unit that was reworded becomes `generated`.
- The update and context-check prompts name the person's pieces ("A person wrote the summary and steps s_ab12, s_cd34. Keep their wording wherever it is still accurate."). The prompt files are unchanged, so their versions are unchanged; only units with a person's wording see the new sentence.

## 8. Natural-Language Editing

### 8.1 What a User Can Edit

In the logic document, per unit:

- Rewrite the text of any step, the summary, an input meaning, or the returns meaning (inline editing, plain text).
- Add a step (after any step, or nested inside an `if`/`loop`/`try` step) or delete one.
- Write a free-form request in the unit's "Ask for a change" box ("Reject negative amounts").

Edits accumulate as a **draft** for the unit until the user clicks **Propose change**. One change request covers one unit (its effects may spread; §8.3). Multi-unit requests are deferred (§13).

### 8.2 Change Request

```ts
interface ChangeRequest {
  id: string;                      // "e_" + 8 base32
  unitId: string;
  file: string;
  base: { bodyHash: string; fileHash: string; description: SiftUnit };
  edits: DescriptionEdit[];        // field-level: { path: "steps[s_b2v7].text", before, after } | add | delete
  request?: string;                // free-form text
  answers: { questionId: string; answer: string }[];
  state: "draft" | "planning" | "needs-answers" | "proposing" | "ready" | "needs-review" | "applied" | "rejected" | "failed";
}
```

Stored in `.sift/edits/<id>.json` (git-ignored, added by `sift init`), not in `.sift/.cache/`, because deleting the cache must never lose information (design §6.5) and a draft is a person's work.

### 8.3 Pipeline

```text
1. Snapshot   record base bodyHash/fileHash; refuse if the unit is stale (describe it first)
2. Locate     edited steps → covers keys → source ranges (§4); deleted/added steps → neighbouring keys
3. Scope      graph: callers (depth 2), implementations, types in the signature, routes reached
4. Plan       AI task edit-plan (§8.4): interpretation, kind, questions, warnings, units allowed to change
                → questions?  state needs-answers; user answers; answers folded into the request; re-plan
                → kind reword? skip to 7 with no code change
5. Code       AI task edit-code (§8.5): replacement text per allowed unit, plus file-level insertions
6. Validate   apply in memory (overlay), re-extract, type-check, scope check, configured commands (§8.6)
                → failures: one retry of 5 with the exact diagnostics; then state failed, reported
7. Re-derive  update prompt on the proposed code with the user's wording marked as preferred
              → logic diff; AI task edit-verify (§8.7) compares the new logic with the request
8. Review     state ready: source diff, logic diff, scope, checks, warnings (§8.8)
9. Apply      on approval only: write source (WorkspaceEdit in the extension), write .sift, record undo
```

Steps 1–7 never touch the user's files.

### 8.4 Plan, Questions, and Warnings (`edit-plan`)

Input: the unit (code with keys, description, user-edited fields), the field-level edits and free-form request, previous answers, callee signatures and summaries, callers' summaries (from §8.3 step 3), rule-pack effects, and the project's relevant conventions (other units that already do what is asked, found by effect — e.g. existing `db.transaction` usages).

Output:

```json
{
  "kind": "behavior" | "reword" | "unclear",
  "interpretation": "Wrap both balance updates in a database transaction.",
  "questions": [{ "id": "q1", "text": "Should a failed notification also roll back the transfer?", "options": ["Yes", "No"] }],
  "warnings": [{ "kind": "missing-check", "text": "The edit still does not check that the amount is positive." }],
  "allowedUnits": [{ "unitId": "u_7f3k2a9q", "reason": "the edited unit" }],
  "broader": null | { "reason": "Changing the return type affects 3 callers.", "units": ["u_…"] }
}
```

- **Ask vs proceed** (open question §15.1, initial rule): ask when the request leaves out something that changes behaviour visibly and has more than one reasonable answer — transaction boundaries, what happens on failure, authorization, which fields change, type precision. Do not ask about naming or code style; follow the project. At most three questions per round. "unclear" with no questions is a failure that tells the user what was not understood.
- **Answers become explicit.** Each answer is folded into the request and the final description must mention it (checked by `edit-verify`), per requirements §3.7.
- **Reword.** When the edit changes wording but not behaviour, no code is generated. The new wording is kept only if `edit-verify` judges it accurate for the current code; otherwise the user sees why it was rejected ("the code does not check the balance; to add the check, phrase it as a change").
- **Broader scope.** If the change needs units beyond the edited one (callers of a changed signature, a shared type), the plan must list them with a reason. The review shows this prominently and requires an explicit second confirmation (requirements §3.6, §11.5).
- Warnings for the edited behaviour use the existing warning kinds and are shown with the proposal.

### 8.5 Code Generation (`edit-code`)

Input: the plan, the full source of each allowed unit with keys, the file's imports, type definitions used by those units (one level deep — the type context the describe prompt deferred), callee signatures, and conventions from §8.4.

Output: whole-unit replacements, not patches:

```json
{
  "units": [{ "unitId": "u_7f3k2a9q", "text": "async transferFunds(…) { … }" }],
  "insertions": [{ "file": "src/accounts/account-service.ts", "at": "imports" | { "before": "u_…" } | "end", "text": "…" }],
  "notes": "Used prisma.$transaction as in PrismaAccountRepository.saveAll."
}
```

- Whole-unit text is the most reliable format across models (requirements §8.3: no model-specific tricks); core computes the minimal line diff for review, so the user still sees a small diff.
- New helper functions are allowed only as insertions in the same file, and the plan must have named them.
- Secret filtering (design §11) applies to everything sent. Code coming back is untrusted (requirements §10.4): it is never executed by Sift except through the configured checks in §8.6.

### 8.6 Validation

All in memory first:

| Check | How | On failure |
|---|---|---|
| Parses | Adapter re-extracts the overlaid file. | Retry once with the error. |
| Type-check | `AdapterProject.diagnostics(overlays)` (§8.9): diagnostics for the changed files and their direct dependants, compared with the same files before; only new diagnostics count. | Retry once with them; then `failed`. |
| Scope | Units whose `bodyHash` changed must all be in `allowedUnits`; nothing else in the file changes (byte comparison outside replaced ranges and insertions). | Rejected without retry; reported as "changed code outside the request". |
| Effects | New effects (e.g. `db.write` appearing) are listed for review; a removed effect that the request did not mention is a warning. | Shown in review. |
| Configured commands | `edit.checks` in `sift.config.yaml` (e.g. `npm run lint`, `npx vitest related`) run against a temporary copy of the project with the change applied, **only when the user clicks "Run checks"** (generated code is not executed without consent, §10.4). | Shown in review as passed / failed / skipped / unavailable. |

The review always lists exactly which checks ran and which did not (requirements §11.8). Nothing is called "correct"; the wording is "type-checks" / "lint passed".

### 8.7 Logic Diff and Intent Check (`edit-verify`)

- The proposed code is re-described with the **update** prompt, with the user's edited wording passed as preferred text for the affected steps. Unaffected steps keep their text and IDs (design §7.4), so the logic diff shows only what the edit changed.
- `edit-verify` (mid tier) receives the request, the answers, the before/after descriptions, and the diff, and returns `{ satisfied: bool, gaps: [...], unrequested: [...] }`: whether the new logic does what was asked, and whether it does anything that was not asked. Gaps and unrequested changes are shown in the review; they do not block approval but are prominent.

### 8.8 Review, Apply, and Undo

The review panel (webview) shows, in order: the interpretation and any answered questions; the logic diff (word-level, inline in the logic document style); the source diff (opened in VS Code's diff editor against a virtual document); scope (units changed, units affected via the graph, routes reached); checks; warnings and `edit-verify` notes.

- **Approve** applies the source change through a `WorkspaceEdit`, so VS Code's own undo works and open editors update, then saves and writes the `.sift` file with the re-derived description: edited steps `user-edited`, the rest as derived.
- **Reject** discards; the draft can be reopened and changed.
- **Undo** after saving: each applied edit records pre-images and post-image hashes of every file it wrote in `.sift/edits/applied/<id>.json`. "Undo Sift edit" restores them only if the files still match the post-images; otherwise it refuses and says which file changed since (the user can still use git).
- The CLI has the same flow: `sift edit <symbol> [--step <id> --text "…"] [--request "…"]` prints the plan, asks the questions on the terminal (or `--answer q1=…`), prints both diffs and checks, and applies only with `--apply`. `sift edit undo <id>`. This is what the evaluation and tests drive.

### 8.9 Pending Edits and Concurrent Changes

- A draft or proposal stores its base `bodyHash` and `fileHash`. When the workspace sees the unit's code change (from the user, an agent, or git), the request becomes `needs-review`: the logic document shows it with "the code changed since this edit was written", and the user can re-plan it against the new code or discard it. It is never applied to code it was not written against (requirements §5.4).
- Applying re-checks the file hash immediately before writing.

### 8.10 Adapter Additions

```ts
interface AdapterProject {
  // existing …
  /** Extract a file as if its text were `text`, without touching disk. */
  extractText(path: string, text: string): FileExtraction;
  /** New-vs-baseline diagnostics for files under overlays. */
  diagnostics(overlays: Map<string, string>, files: string[]): Diagnostic[];
}
interface Diagnostic { file: string; range: SourceRange; message: string; code: string; severity: "error" | "warning"; }
```

Implemented with a `CompilerHost` overlay and `oldProgram` reuse, so a check costs a fraction of a full program build.

### 8.11 Routing

| Task | Recommended tier | Minimum tier | Effort (claude-code) |
|---|---|---|---|
| `edit-plan` | frontier | mid | high |
| `edit-code` | frontier | frontier | high |
| `edit-verify` | mid | mid | medium |

`edit-code` follows requirements §8.2 (frontier minimum). `edit-plan` starts at frontier with mid as minimum; it moves to mid only if the edit evaluation (§9) shows mid matches on question recall and scope. Prompts live in `packages/core/prompts/edit-*.md`, versioned, with two short examples each, following design §7.5.

### 8.12 As Built (M14): Editing Engine

No new libraries. Core: `edit-service.ts` (pipeline, storage, apply/undo), `edit-prompts.ts` (prompt inputs, schemas, checks), `edit-text.ts` (description edits, source splicing, diffs), `open-projects.ts`; prompts `edit-plan@1`, `edit-code@1`, `edit-verify@1`.

- **Open adapter projects** (§4). `Workspace` hands the engine `OpenProjects.adapters`: `openProject` returns one held project per adapter and brings it up to date with `AdapterProject.refresh(files)` instead of building it again. The TypeScript project rebuilds its program with `oldProgram` and a host that returns the previous `SourceFile` for any file whose size and mtime are unchanged (a stat per file, no read), so a refresh re-parses only what changed. It answers `false` (reopen) when `tsconfig.json`/`jsconfig.json` changed. Generate, status, and the graph refresh all go through it.
- **Adapter additions** (§8.10), optional on `AdapterProject` so other adapters can come later: `extractText`, `diagnostics(overlays, files)`, `refresh`, and `declarationText(ref)` (type context for `edit-code`). `diagnostics` builds the disk program and the overlaid one (cached per overlay set, so `extractText` and `diagnostics` share it), checks the overlaid files, `files`, and every project file that imports an overlaid file, and returns the diagnostics the overlay added, matched by file, code, and message (positions shift). Syntax errors are TS1xxx; everything else of severity error counts as a type error.
- **Change requests** (§8.2) as designed, plus `symbol`, `questions` (open ones), `rounds`, `plan`, `proposal`, `error`, `review`, `usage` (per task), and timestamps. `answers` keep the question text, since a later round may reuse `q1`. A new state `undone`. `planning`/`proposing` are only ever seen while running; a request left in them by a stopped process reads as `draft`. Description edits are `{ op: "set", path, before, after }` (`summary`, `returns.meaning`, `inputs[<name>].meaning`, `steps[<id>].text`), `{ op: "add", id, text, after? | parent? }`, and `{ op: "delete", step }`; a `before` that no longer matches is refused.
- **Pipeline** (§8.3). `create` refuses a unit whose description is out of date or stale. `propose` runs steps 1–8 in one call, outside the workspace's write queue (AI calls never block reads), and ends in `needs-answers`, `ready`, `needs-review`, or `failed` (with the reason and details). Questions: at most three per round, three rounds at most; `answer` then `propose` again. `kind: unclear` without questions fails with the interpretation. A cancelled run, or one stopped by a provider login problem, goes back to `draft`.
- **Plan input** (§8.4): the unit's code with structure keys, its description as it was, the person's edits and request and answers, what it calls (with effects), callers to depth 2, the member it implements and the other implementations, project types, routes that reach it, and up to two units per effect elsewhere in the project. The plan adds `helpers` (new functions, by file and name) and `examples` (units whose code `edit-code` gets as conventions). Units other than the edited one must be named in `broader`; a behaviour plan must allow the edited unit.
- **Code** (§8.5): units are named `file#Symbol` (not `u_` IDs, so undescribed units work too). Insertions go `at: "imports"`, `"end"`, `{ before: ref }` (above its doc comment), or `{ after: ref }`; anything but imports needs a helper named in the plan for that file. Replacement text is re-indented to the unit's place and takes the file's line endings; everything else is kept byte for byte. A unit that contains a redacted secret is refused before anything is sent, since the model cannot write it back; a response containing `<redacted>` is refused too.
- **Validation** (§8.6): parse, type-check (new diagnostics only), and scope run in memory. Scope compares each unit's `bodyHash` before and after: only allowed units may change, none may disappear or be renamed, and new units must be planned helpers. Parse and type errors get one retry with the exact diagnostics and the previous response; a scope failure is not retried. Effects added or removed are listed; a removed effect becomes a review warning. Configured commands (`edit.checks` in `sift.config.yaml`: a command, or `{ name, command }`; `edit.checkTimeoutSeconds`, default 300) are listed as skipped until `runChecks`, which copies the project to a temp folder (node_modules linked, `.git` and Sift state left out), writes the proposed files, and runs each through the shell: passed, failed (last 30 lines), or unavailable (command not found).
- **Re-derive** (§8.7). `redescribeUnit` (generate.ts) runs the update prompt on the proposed code, starting from the *draft* description (the base with the person's edits applied and marked `user-edited`), so unchanged steps keep their IDs and the person's wording is kept where accurate. The prompt also says what was asked and each answer. Afterwards the unit is `generated` (or `stale` if keys are uncovered), provenance is carried, nothing stays verified, and the base's warnings the change no longer has stay as `resolved: { by: "edit" }` (the next update drops them; the update prompt no longer shows resolved warnings). If the re-derivation reworded the person's text, the review says so. Other changed units that have descriptions are re-derived from their current description; undescribed ones and new helpers wait for `generate`. `edit-verify` then compares before/after with the request.
- **Reword**: the draft description is the proposal (no code, no re-derivation), kept only if `edit-verify` says it is accurate for the current code; otherwise `failed` with the inaccuracies. Adding or deleting steps is never a reword.
- **Apply and undo** (§8.8). `apply` needs `ready` (and `confirmBroader` when `scope.broader` is set), runs in the write queue, re-reads each file and refuses if its text hash differs from the proposal's, writes sources, then the `.sift` files (re-derived units replaced by ID; `fileHash` moves to the new text only if the file was in sync before and the change added no undescribed units), and records `.sift/edits/applied/<id>.json` with every pre-image and post-image hash. With `sourceWritten` (the extension applies the source through a `WorkspaceEdit`, M15), Sift checks the files hold exactly the proposed text and writes only the descriptions. `undo` restores only if every file still matches its post-image hash; otherwise it refuses and names the files.
- **Pending edits** (§8.9). `get`, `list`, and every refresh that rebuilt files (after the operation, if `.sift/edits/` exists) mark open requests `needs-review` when their unit's `bodyHash` changed or, for a ready proposal, any of its files changed — except when the files hold exactly the proposed text (the editor is applying it). `rebase` starts such a request over from the current description, keeping the edits that still fit. Workspace emits `{ type: "edits", ids }`.
- **Routing**: tasks `edit-plan` (frontier, minimum mid, effort high), `edit-code` (frontier, minimum frontier, effort high), `edit-verify` (mid). A model fallback never goes below a task's minimum tier.
- **CLI**: `sift edit <symbol>` with `--request`, `--step <id> --text`, `--add-after <id>`/`--add-first --text`, `--delete <id…>`, `--summary`, `--returns`, `--input name=text`, `--answer q=…`, `--apply`, `--confirm-broader`, `--run-checks`, `--json`; subcommands `list`, `show`, `answer`, `propose`, `replan`, `checks`, `apply`, `reject`, `undo`. Questions are asked on the terminal when stdin is one; otherwise the command stops at `needs-answers` and prints the `answer` command. Exit code 1 for `needs-answers`, `failed`, and `needs-review`.
- **Protocol** (additive, still version 1): `sift/edit/create`, `update`, `get`, `list`, `propose` (cancellable; progress as `sift/editProgress` with the request's `token`), `answer`, `runChecks` (cancellable), `apply`, `reject`, `rebase`, `undo`; `sift/didChange` can carry `{ type: "edits", ids }`.
- `.sift/edits/` is added to `.gitignore` by `sift init` and is not a logic-file folder.
- **Tests.** Core: description edits, source splicing (re-indent, imports, before/after/end, CRLF), unified diff, plan and code validation. Adapter: `extractText` equals `extractFile`, `diagnostics` reports only new errors including a broken caller in an importing file and syntax errors, `refresh` follows the disk and asks to reopen on a tsconfig change. CLI end to end over the fixture with a stand-in model: propose → apply → undo byte-exact; questions answered later and ahead of time; one retry with the type errors; scope rejection without retry; accurate and false rewording; pending edit marked for review; undo refused after a later change; broader confirmation; configured checks (passed, failed, unavailable) in a copy. Server: create → propose with progress → apply with `sourceWritten` → undo.

### 8.13 As Built (M15): Editing UI

No new libraries. Extension: `edits.ts` (`EditController`), `review-panel.ts`, `edit-host-model.ts`; webview: `edit-model.ts`, `edit-panel.tsx`, editing in `logic-document.tsx`, and a third bundle `dist/review.js`/`review.css` (`review-view.tsx`). Core: `description-edits.ts` holds `applyDescriptionEdits` and `findStep` with no Node imports, so the webview shows a draft with the engine's own code (through `core-runtime.ts`).

- **Drafts in the logic document** (§8.1). **Edit** on a fresh, unflagged unit (or **Sift: Edit Logic of This…** from the code, which opens the logic with the unit in edit mode) makes the summary, input and return meanings, and step texts editable in place (a textarea; Enter keeps, Escape cancels, blur keeps). Steps get `+` (after), `↳` (inside a step with a kind), and `×`; edited fields and steps are marked *changed*/*new*, removed steps are listed with **Restore**, and `↺` reverts one change. The webview keeps the draft as `DescriptionEdit`s on the request's base (one `set` per path with the base text as `before`; an added step's text lives in its `add`; adds are kept before deletes so their anchors exist) and renders `applyDescriptionEdits(base, edits)`. Each change is sent as `draft` with a sequence number; the host creates, updates, or (when nothing is asked) rejects the unit's change request, one save at a time per unit, sends the new state, then `draftSaved`, after which the webview drops its own copy. The free-form request is saved on blur.
- **Which request a unit shows.** The newest request on the unit in `draft`, `planning`, `needs-answers`, `proposing`, `ready`, `needs-review`, or `failed`. The document reloads requests on every `sift/didChange` of type `edits` and on each status refresh (which also runs `checkPending`). A unit with a request shows the draft description and a panel under it: the request box and **Propose change** (with where the code is sent), progress with **Cancel** while proposing (from `sift/editProgress`: planning, writing, fixing the type errors on the retry, checking, describing, comparing with the request), the questions, the outcome, and **Discard** (reject).
- **Questions** (§8.4) are radio buttons per option plus a free answer; **Answer and continue** sends `sift/edit/answer` for all of them and proposes again.
- **Review panel** (§8.8), one webview panel per request (`sift.review`), opened when a proposal comes back `ready` (or with **Review change…**). In order: the request, answers, and interpretation; the logic diff per unit (word-level `ins`/`del` from an LCS over words; added and removed steps, effects, warnings); the source diff inline plus **Open diff** (VS Code's diff editor against a `sift-proposal:` virtual document); scope (units whose code changes, units and routes that may be affected, effects added and removed); the checks, worded as what ran ("type-checks", "changes only what the plan allowed", "`npm run lint` not run"), with **Run configured checks**; then the intent check's gaps ("Not done") and unrequested changes ("Not asked for"), plan warnings, and the code step's notes. A broader scope and an unmet intent are also banners at the top. Approve is disabled while any file the change writes has unsaved changes. After applying it shows **Undo**; other end states say what happened.
- **Approve** (§8.8, §8.9). A broader change asks again in a modal. Each file must still hash to the proposal's `beforeHash`. If every editor's text equals the file on disk, one `WorkspaceEdit` replaces each file's text and the documents are saved (VS Code's undo stack holds the change, and open editors follow); a save participant (format on save) that changes the text is overwritten with the reviewed text. Then `sift/edit/apply` with `sourceWritten` and `sourceBefore` (the replaced text); if Sift refuses, the files are put back. When an editor's text differs from the disk (line endings, encoding), Sift writes the files itself instead. `apply` now records the source pre-images it is given, so **Sift: Undo Edit…** (a QuickPick of applied requests) and **Undo** in the review restore code and description together, refusing if any file changed since or has unsaved changes.
- **Engine fix found by the UI.** `checkPending` read the requests, awaited the code, then saved its copy; a reject (or update) in between was overwritten with `needs-review`. Writes to one request now run one at a time, and `checkPending` marks a request only if it is unchanged since it was read (server test: a `list` racing a `reject` leaves it rejected).
- **Needs review** (§8.9): the unit shows the current description (not the draft), "The code changed since this edit was written", what was asked, **Re-plan on the current code** (`rebase`, a warning if edits were dropped, then propose), and **Discard**. A draft cannot be changed while it needs review or is being proposed.
- **Tests.** vitest: the draft model (set/revert, add after/inside/first, removing added and base steps, anchors kept with deletes, word diff); the host model (which request a unit shows, what a draft save does, progress mapping, `textHash` equal to core's, files an apply writes); jsdom renders of editing in the document (edit mode, in-place step and summary edits, Escape, adding and removing steps, the request and Propose, progress and Cancel, questions and answers, ready/failed/needs-review panels, Edit only on fresh units, edit mode on request) and of the review (section order, word diff, checks wording, approve/reject/undo/open intents, broader and intent banners, dirty files, end states). The server test applies with `sourceBefore` and undoes the source too. Integration (`run-integration.mjs` proposes a change to `withdraw` with the stand-in model first): the review opens with its diff editor, approving changes the open editor through a `WorkspaceEdit` and leaves it saved, the description is re-derived, undo restores both byte for byte; a draft saved from the document becomes a change request and is marked for review when its code changes.
- Limits found: [extension-limits.md](extension-limits.md) #8–#10.

## 9. Evaluation of Editing

Requirements §14: "percentage of natural-language edits that produce correct, targeted changes" and "frequency of unrelated code changes".

`eval/edits/bank-app.yaml`: scripted change requests against the fixture, each with expectations:

```yaml
- id: transfer-transaction
  unit: src/accounts/account-service.ts#AccountService.transferFunds
  edit: { step: "saves both accounts", text: "Inside a database transaction, save both accounts." }
  expect:
    kind: behavior
    changedUnits: [AccountService.transferFunds]      # nothing else may change
    effectsAdded: [db.transaction]
    mustMention: [both saves happen in one transaction]
- id: withdraw-ambiguous
  unit: src/accounts/account-service.ts#AccountService.withdraw
  request: "Don't let people overdraw."
  expect:
    asks: [what happens when the balance is too low]   # judge matches the question
- id: reword-only
  …
  expect: { kind: reword }
```

Initial set: about 15 requests covering a step rewrite, an added step, a deleted step, a free-form request, a reword-only edit, a reword that is actually false, an ambiguous request, a type change (`number` → bigint cents) that reaches callers, and an edit on an interface implementation.

Metrics (added to the summary table and `--matrix`):

| Metric | How |
|---|---|
| Type-checks | Proposals with no new diagnostics after retry. |
| Targeted | Proposals whose changed units equal `changedUnits` (0 unrelated changes). |
| Intent | Judge: does the new code do what was requested (correct / minor / wrong), with the same context as `edit-verify` but on the frontier tier. |
| Question recall / precision | Expected questions asked; questions asked when none were expected. |
| Reword accuracy | Reword-only edits accepted; false rewordings rejected. |
| Cost / latency | Per edit, by task. |

The fixture's stubs mean it cannot run, so behavioural correctness is judged, not tested; Phase 3's test integration will add executed checks.

Initial exit targets (tuned on the first baseline, like design §4.4): type-checks 100% after retry, targeted ≥ 90%, intent acceptable ≥ 85% with none wrong on the frontier tier, question recall ≥ 80%, reword accuracy 100%.

### 9.1 As Built (M16): Edit Evaluation

No new libraries. Harness: `edit-cases.ts` (the edit set), `edit-eval.ts` (runner, checks, metrics), `edit-judge.ts`, `edit-report.ts`; core: task `edit-judge` (frontier, minimum frontier, effort high) and prompt `edit-judge@1`.

- **Edit set** (`eval/edits/bank-app.yaml`, 17 cases): step rewrites, added and deleted steps, free-form requests, two ambiguous requests, a type change (`formatCents` to `bigint`) that reaches `BalanceCard`, an interface implementation (`PrismaAccountRepository.save`), three accurate rewordings (summary, step, input), and a false one. Steps are named by a piece of the code they cover (the step owning the innermost statement that contains it), since step IDs differ between runs. `answers` is what the person says to any question.
- **Expectations**: `kind`, `reword` (true: accepted with no code; false: never accepted as a rewording; a planner that turns a false wording into a behaviour change passes, as `edit-plan` is told to), `changedUnits` (exact), `broader`, `effectsAdded`/`effectsRemoved`, `asks` (topics, matched by the judge), `questionsOk`, `mustMention` (what the change must do, judged on the diff).
- **Run** (`sift eval --edits [--case …] [--matrix] [--tier …] [--no-judge]`): a fresh fixture copy per configuration and repeat; `generate` describes it; then each case is created, proposed, and answered (at most three rounds) through `Workspace.edits`, concurrently up to `concurrency`. Nothing is applied; each request is rejected afterwards. A matrix configuration's tiers go into the copy's `sift.config.yaml`. `eval/matrix.yaml` gained an `edits` list (`recommended`, `edit-plan-on-mid`). Results: `eval/results/<timestamp>-edits.json` and `.md`; the command exits 1 when a configuration misses a §9 target.
- **Judge** (`edit-judge`): the code before, what was asked (as the edit prompts render it), the questions with their answers, the diff, the description re-derived from the new code, the expected ideas and questions. It returns per-idea and per-question matches, and `intent` (`correct` / `minor-issues` / `wrong`, `null` without a diff). It runs only where there is a code change or an expected question.
- **Metrics** as in the table above. Type-checks counts behaviour proposals and failures with parse or type errors after the retry; question recall counts expected topics asked in any round; unneeded questions counts first-round questions in cases that expected none (unless `questionsOk`); latency is AI time per edit, judge excluded.
- **Prompt iteration.** Baseline with `edit-plan@1` on Opus 5.5 met every target. Its one failure, `transfer-transaction`, came from the plan naming `AccountRepository.save`, an interface member, which Sift cannot change (only units can be replaced). With `edit-plan` on mid (Sonnet 5.5), the same gap showed as type errors (calling a repository method no interface declares) in two cases, so type-checks fell to 86%: **`edit-plan` stays on frontier** (§8.11). `edit-plan@2` says what can change (units only; adding imports is allowed) and that a change needing a declaration changed first is `unclear` with that explanation. The plan input now also carries the edited file's import block: without it, the planner believed `ValidationError` did not exist.
- **Baseline** (`2026-11-25T14-55-40Z-edits`, recommended routing): type-checks 100% (13/13), targeted 100% (12/12), intent acceptable 100% (13 judged, 0 wrong), question recall 100%, unneeded questions 0%, rewording 100% (4/4), mentions 94%; about $0.10 per edit and 18 s mean (30 s p95) of AI time. The judge is self-graded (same vendor). The one case not done is `transfer-transaction`, which now fails with an explanation naming the interface to change first.
- Engine fix found along the way: the re-derivation's time was not added to the request's per-task usage.
- Limit found: changes that need an interface, type, or class declaration edited are out of reach until edits can target declarations (§13).

## 10. Engine and Extension Testing

- **Core:** workspace refresh and events; `sourceRanges` / `stepAt` on the fixture; schema v1 read/write and v0 → v1 upgrade (byte-stable for untouched files); change-request state machine; scope check; pending-edit invalidation; undo pre-image checks. All with `FakeProvider`.
- **Adapter:** `extractText` equals `extractFile` for the same text; `diagnostics` reports only new errors; overlay performance smoke test.
- **Server:** protocol round-trip tests in-process (both ends of `vscode-jsonrpc` over a pipe).
- **MCP:** tool schemas and outputs against the fixture through the SDK's in-memory transport; stale descriptions are always marked.
- **Extension:** webview components tested in vitest with jsdom (pure render from `LogicFile`); `@vscode/test-electron` integration tests for activation, Open Logic, Ctrl+click navigation, implementation picker, and apply/undo of a canned edit.
- **End to end:** `sift edit` with `FakeProvider` over the fixture, plus the real-provider contract test behind the existing environment flag.

## 11. Exit Criteria for Phase 2

- An agent in Claude Code, with only `sift mcp`, can answer "what does `transferFunds` do and what breaks if I change it?" from Sift's tools on the fixture, and never receives an unmarked stale description.
- Every fixture file opens as a logic document; step ↔ source highlighting and Ctrl+click navigation are exact for every resolved call, including both `AccountRepository` implementations through the picker.
- Flow from each Express route in the fixture reaches the Prisma calls with their effects.
- The edit evaluation meets the §9 targets, recorded in `eval/results/`.
- No path applies a code change without approval; undo restores files exactly or refuses.
- `npm run verify` and the extension integration tests pass on Windows, macOS, and Linux (CI matrix).

## 12. Milestones

| # | Milestone | Contents | Depends on |
|---|---|---|---|
| M9 | Workspace and schema v1 | `Workspace` (§4), CLI moved onto it, `sourceRanges`/`stepAt`, `flow(route)`, schema v1 + `sift migrate` + `sift verify`, per-step user-edited handling in update/context-check prompts, `sift serve` protocol | — |
| M10 | MCP server | `@sift/mcp`, tools (§5), README setup, tests | M9 |
| M11 | Extension shell | Packaging (esbuild, `.vsix`), server process lifecycle, status bar, explorer decorations, callers/callees/status tree views, generate with dry-run estimate | M9 |
| M12 | Logic document | Custom editor, side by side, highlighting both ways, badges, verify, Ctrl+click and implementation picker, external hovers | M11 |
| M13 | Graph views | Neighbourhood, flow, impact diagrams (elkjs) | M11 (parallel with M12) |
| M14 | Editing engine | Change requests and storage, adapter overlays and diagnostics, `edit-plan`/`edit-code`/`edit-verify` prompts, validation, scope check, re-derive, pending edits, apply/undo, `sift edit` CLI | M9 (parallel with M10–M13) |
| M15 | Editing UI | Inline editing and drafts in the logic document, question UI, review panel, approve/reject/undo, needs-review state | M12, M14 |
| M16 | Edit evaluation | Edit set, metrics, judge, `--matrix` support, first baseline, prompt iteration to the §9 targets | M14 |
| M17 | Release | README and docs, CHANGELOG, versions to `0.2.0`, `.vsix` build, merge `develop` → `main`, tag `v0.2.0` | all |

M9 is the only hard bottleneck. After it, three tracks can run side by side on separate branches: **agents** (M10), **extension** (M11 → M12/M13 → M15), and **editing engine** (M14 → M16). M16 can start as soon as M14 lands, so prompt iteration overlaps the UI work.

## 13. Decisions Deferred Within Phase 2

- Multi-unit change requests (one edit spanning several units at the user's choice, not just through `broader` scope).
- Whether the logic document should also support editing as plain text (whole-document diffing) rather than field-level edits only.
- Natural-language diff presentation details (word-level inline vs side by side) — start inline, revisit after use (open question §15.3).
- Whether `edit-plan` and `edit-code` merge into one call for simple edits, to cut cost, once the evaluation shows it holds quality.
- MCP tools that propose (not apply) edits for agents.
- Edits that change declarations (interface members, type aliases, classes and their fields), so a change such as a repository transaction can be planned in one request (§9.1).
- Automatic re-description on save (beyond `ask`).
- Recording "limits that would justify a fork" (requirements §9.1): kept as a running list in `docs/extension-limits.md` from M11 on.
