# Sift — Phase 1 Design: Derivation Engine

Status: draft v0 · Scope: Phase 1 of [requirements.md](../requirements.md)

## 1. Scope

Phase 1 builds a command-line tool that reads a TypeScript/JavaScript project and produces `.sift` files: persistent, natural-language descriptions of each function, kept in sync with the code.

In scope:

- Core engine, `.sift` schema v0, serialization.
- TypeScript/JavaScript language adapter.
- Framework rule packs (built-in: Prisma, Node `fs`, `fetch`, Express routes; plus project rules).
- Code graph with edge confidence, impact analysis.
- AI provider interface and the Claude Code CLI provider.
- Generation pipeline, validation, incremental regeneration, staleness detection.
- CLI commands: `init`, `generate`, `status`, `check`, `show`, `callers`, `callees`, `impact`, `eval`.
- Evaluation set and harness.

Out of scope for Phase 1: natural-language editing (logic → code), the MCP server, the VS Code extension, test association, Python. Bring-your-own-key providers (§4.3) are designed now so the interfaces fit them, but built after Phase 1's evaluation baseline exists.

The design keeps Phase 2 in mind: every step records which code it covers and which units it calls, which is what editing and Ctrl+click navigation will need.

## 2. Architecture

```text
            ┌───────────────────────────────────────────────┐
            │                    cli                        │
            └───────────────────────┬───────────────────────┘
                                    │
            ┌───────────────────────▼───────────────────────┐
            │                    core                       │
            │  schema · serializer · ids · hashing · cache  │
            │  pipeline · validation · identity matching    │
            │  code graph · rule-pack engine · prompts      │
            │  secret filter                                │
            └──────┬──────────────────────────────┬─────────┘
                   │ LanguageAdapter               │ Provider
        ┌──────────▼──────────┐        ┌───────────▼───────────┐
        │   adapter-typescript │        │ provider-claude-code  │
        │ (TypeScript compiler)│        │     (claude -p)       │
        └──────────────────────┘        └───────────────────────┘
```

Rule: **core never imports the TypeScript compiler, and never spawns `claude`.** It only talks to the two interfaces.

### 2.1 Repository Layout

npm workspaces monorepo, TypeScript, Node 20+.

```text
sift/
├── packages/
│   ├── core/                  # language- and provider-independent
│   ├── adapter-typescript/    # LanguageAdapter for TS/JS
│   ├── provider-claude-code/  # Provider using `claude -p`
│   ├── rules/                 # built-in rule packs (YAML) + loader tests
│   └── cli/                   # `sift` command
├── eval/
│   ├── fixtures/bank-app/     # evaluation codebase
│   ├── expectations/          # what each unit must mention / warn about
│   └── harness/               # runs generation + scoring
├── docs/
└── requirements.md
```

Package dependencies enforce the boundary: `core` depends on neither `adapter-typescript` nor `provider-claude-code`. `cli` wires them together.

Libraries: `typescript` (compiler API), `yaml` (formatting-preserving Document API), `vitest` (tests), `commander` (CLI). No others without a reason.

`typescript` is pinned to **6.0.x**. TypeScript 7 (the native compiler) does not ship the JavaScript compiler API (`ts.createProgram`, the type checker) that the TS adapter is built on. Moving to 7 waits until it offers an equivalent API; the adapter boundary keeps that change contained to one package.

## 3. Language Adapter Interface

All adapter output is plain, serializable data.

```ts
interface LanguageAdapter {
  id: string;                                  // "typescript"
  extensions: string[];                        // [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

  /** File-level normalized hash (§5), equal to FileExtraction.fileHash. Runs without a project, for the fast path (§5.1). */
  hashFile(path: string, text: string): string;

  /** Load the project (tsconfig/jsconfig, or defaults). Called once. */
  openProject(root: string, files: string[], options?: { liteMaxStatements?: number }): Promise<AdapterProject>;
}

interface AdapterProject {
  /** Extract every unit in a file, with structure, types, calls, and normalized hashes. */
  extractFile(path: string): FileExtraction;

  /** All implementations of an interface/abstract member (for navigation and call resolution). */
  findImplementations(symbol: SymbolRef): SymbolRef[];

  dispose(): void;
}

interface FileExtraction {
  path: string;
  language: string;                            // "typescript" | "javascript"
  fileHash: string;
  units: ExtractedUnit[];
}

interface ExtractedUnit {
  symbol: string;                              // "AccountService.transferFunds"
  kind: "function" | "method" | "constructor" | "component" | "module";
  isSmall: boolean;                            // adapter's lite-unit heuristic (§6.4)
  signature: string;                           // as written in source
  inputs: { name: string; type: string; typeInferred: boolean }[];
  returns: { type: string; typeInferred: boolean } | null;
  bodyHash: string;                            // normalized (§5)
  range: SourceRange;
  body: StructureNode[];                       // statement tree (§3.1)
  docComment: string | null;                   // JSDoc / leading comments
  sourceText: string;                          // for the prompt
  typeRefs: SymbolRef[];                       // project types used in signature or body
  implementsMember: SymbolRef | null;          // interface/abstract member this method implements
}

interface StructureNode {
  key: string;                                 // structural path, e.g. "3", "3.then.0" (§3.1)
  kind: "statement" | "if" | "else" | "switch" | "case" | "loop"
      | "try" | "catch" | "finally" | "return" | "throw" | "callback";
  range: SourceRange;
  text: string;                                // source snippet
  calls: CallSite[];
  children: StructureNode[];
}

interface CallSite {
  expression: string;                          // "this.repo.getAccount(id)"
  target: SymbolRef | null;                    // resolved declaration, or null
  confidence: "resolved" | "language-server" | "name-match" | null;   // how target was found
  implementations: SymbolRef[];                // if target is an interface/abstract member
  external: { module: string; name: string } | null;   // e.g. { module: "@prisma/client", name: "Prisma.AccountDelegate.update" }
  awaited: boolean;
  args: CallArg[];                             // simplified arguments, for edge rules (§9.1)
  range: SourceRange;
}

type CallArg =
  | { kind: "string"; value: string }
  | { kind: "unit"; ref: SymbolRef }           // reference to a named project function or method
  | { kind: "callback"; key: string }          // inline function: its callback node's key in this unit
  | { kind: "unknown" };

interface SymbolRef { file: string; symbol: string; }
interface SourceRange { start: { line: number; col: number }; end: { line: number; col: number }; }
```

### 3.1 Structure Nodes and Keys

The adapter turns a unit's body into a tree of statement-level nodes. Expressions are not split further; a node is a statement or a control-flow construct.

Each node has a **structural key**: its path in the tree. Top-level statements are `"0"`, `"1"`, …; children are addressed by role:

| Construct | Node keys |
|---|---|
| `if` / `else` | `if` node `k`; then-statements `k.then.i`; an `else` node `k.else` with statements `k.else.i` (an `else if` is an `if` node at `k.else.0`) |
| Loops (`for`, `for…of`, `for…in`, `while`, `do…while`) | `loop` node `k`; body `k.body.i` |
| `try` | `try` node `k`; statements `k.try.i`; `catch` node `k.catch` with `k.catch.i`; `finally` node `k.finally` with `k.finally.i` |
| `switch` | `switch` node `k`; `case` nodes `k.caseN` (including `default`) with `k.caseN.i` |
| Bare block `{ … }` | `statement` node `k`; contents `k.body.i` |
| Inline function (callback, nested function) | `callback` node `k.cbN` under the node whose code contains it; its body `k.cbN.i` |

Calls are attached to the node whose own code contains them: an `if` node holds the calls in its condition, not those in its branches, and calls inside an inline function belong to its `callback` node. Callback bodies can therefore be covered by the step that describes the enclosing statement.

Keys are only meaningful against a specific `bodyHash`. When the hash changes, the unit is regenerated and keys are re-assigned (§7).

### 3.2 TypeScript Adapter Notes

- **Program:** `ts.createProgram` with `tsconfig.json` or `jsconfig.json` from the project root only (never a parent directory's), plus any requested files. `noEmit` and `allowJs` are always forced on. Without a config, defaults are used (ES2022, bundler resolution, JSX preserved, strict).
- **Units:** function declarations; `const x = function / arrow`; class methods, getters/setters (`Store.get size`), constructors (`Store.constructor`), and arrow-function properties; methods of object literals assigned to constants (`handlers.create`); default exports (`default`).
- **`component`:** a function that returns JSX.
- **`module`:** one unit per file (`<module>`) collecting top-level statements that do work: any statement other than imports, exports, and type declarations, and variable declarations whose initializer calls, constructs, or awaits something. Constants such as `const PORT = 3000` are not work.
- **Names:** a unit's symbol is its qualified name in the file: classes, namespaces, and the owning variable of an object literal are included; nested local functions are not units (they are `callback` nodes).
- **Types:** from annotations as written when present (`typeInferred: false`, including JSDoc types), otherwise from the type checker (`typeInferred: true`), which is always the case for unannotated JavaScript.
- **Comments:** `docComment` holds only comments directly above the unit, with no blank line between, so a file header is not mistaken for a function's documentation.
- **Call resolution** (`confidence: "resolved"`):
  - Calls go through `checker.getResolvedSignature` to the declaration. `new X()` resolves to `X`'s own constructor, or to the class `X` when it has none; this avoids resolving to an inherited library constructor such as `Error`'s.
  - If the declaration is an interface member or abstract method, `implementations` lists the class members that implement it. Only classes that name the interface or base class in `implements` / `extends` are found; purely structural implementations are not.
  - A call through a function-typed variable or parameter (e.g. an event handler) is **unresolved**: `target` and `confidence` are null, never guessed.
- **External calls:** a declaration outside the project's own source files (in `node_modules`, a `.d.ts` file, or the default library) is external. `module` is the ambient module name (`declare module "fs/promises"`), `"global"` for global declarations and the default library, or else the package name (`@types/x` maps to `x`). `name` is the declaration's qualified name inside that module, e.g. `Prisma.AccountDelegate.update`, `Router.post`, `Math.floor`. Rule packs match on these names (§9).
- **Name matching** (`confidence: "name-match"`): only when the checker gives the callee type `any` (typically untyped JavaScript) and exactly one project unit has that simple name.
- **Lite heuristic** (`isSmall`): at most `liteMaxStatements` structure nodes, no control flow, callbacks, or `throw`, and no external calls except into the language's standard library (`Math`, `Array`, `JSON`, …). Core can still override it once rule packs find effects.

## 4. Provider Interface

```ts
interface Provider {
  id: string;                                  // "claude-code", later "anthropic", "openai", "google", "openai-compatible"
  capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

interface ProviderCapabilities {
  nativeJsonSchema: boolean;                   // can the provider enforce the output schema itself?
  contextTokens(model: string): number;        // prompt budget for this model
  effortLevels: boolean;                       // does it accept an effort / reasoning setting?
  local: boolean;                              // code stays on the user's machine
}

interface CompletionRequest {
  task: Task;                                  // routed to a model (§4.2)
  model: ModelChoice;                          // resolved by core from the routing table
  promptVersion: string;                       // e.g. "describe@3", recorded in results
  system: string;
  prompt: string;
  jsonSchema: object;                          // expected output shape
  maxOutputTokens?: number;
  signal?: AbortSignal;                        // cancel the request
}

type Task = "describe" | "describe-lite" | "update" | "context-check" | "judge";
type Tier = "frontier" | "mid" | "small";
interface ModelChoice {
  provider: string;
  model: string;
  tier: Tier | "unqualified";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";   // ignored by providers without effort levels
}

interface CompletionResult {
  json: unknown;                               // parsed; validated by core; undefined if the reply was not JSON
  text?: string;                               // raw reply, for error messages
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  model: string;
  durationMs: number;
}
```

### 4.1 Claude Code Provider

Implemented in `packages/provider-claude-code` and checked against Claude Code 2.1:

```text
claude -p --output-format json --model <model> [--effort <level>]
       --system-prompt-file <tmp>/system.md --tools "" --setting-sources ""
       --strict-mcp-config --no-session-persistence
```

- The prompt goes in on stdin; the system prompt (instructions and examples) through a file, since it is too long for some shells. **No tools** (the model only reads the prompt, never acts on the repository), **no setting sources and no MCP servers**, and the working directory is an empty temp folder, so nothing from the project or the user's configuration is picked up. `--bare` would be stricter but only accepts API keys, not a subscription login.
- The JSON envelope is parsed; the reply is `structured_output` when present, otherwise the JSON object found in `result` (whole text, fenced block, or outermost braces). A reply that is not JSON comes back with `json: undefined` and is treated as a validation failure (one retry).
- `--json-schema` (native schema enforcement) is supported by the provider but off (`nativeJsonSchema: false`) until it has been verified with the recursive step schema on real runs; the schema is described in the prompt instead (§4.3).
- Errors are mapped so core can act on them: a login problem is `PROVIDER_AUTH` and stops the whole run with "run `claude` and log in"; an unavailable model is `MODEL_UNAVAILABLE` and triggers routing fallback (§4.2); anything else fails only that unit.
- Per-call timeout (10 minutes); concurrency is limited by core (`concurrency`, default 4). `SIFT_CLAUDE_COMMAND` overrides the executable.
- Records usage for cost reporting (input tokens include cache reads and writes). On a subscription, cost figures are estimates for comparison, not a bill; usage limits are the real constraint, which is another reason to route simple tasks to small models.

A `FakeProvider` that returns canned responses is used for engine tests.

### 4.2 Model Routing

Routing is two lookups: **task → tier**, then **tier → model** for the active provider (requirements §8.2).

Task → tier (fixed in core):

| Task | Recommended tier | Minimum tier |
|---|---|---|
| `describe` | frontier | mid |
| `describe-lite` | small | small |
| `update` | frontier | mid |
| `context-check` | small | small |
| `judge` | frontier | frontier |

Tier → model (shipped per provider in `packages/core/models/<provider>.yaml`):

```yaml
provider: claude-code
tiers:
  frontier: { model: claude-opus-5-5,   effort: medium, effortByTask: { judge: high } }
  mid:      { model: claude-sonnet-5-5, effort: medium }
  small:    { model: claude-haiku-5-5,  effort: low }
fallback: { frontier: [mid], mid: [small] }
```

- Mapping files for other providers are added with each provider, filled from that provider's evaluation results (§13.4).
- If a model is unavailable (plan, region, or key permissions), core walks the `fallback` list and reports the substitution in the run summary. The substitution is remembered for the rest of the run, so the unavailable model is tried once. Running below the recommended tier is recorded in the unit's provenance (`belowTier`); below the minimum tier is also reported in the run summary.
- Users override either lookup in `sift.config.yaml` (§12): move a task to another tier, or remap a tier to another model. Personal overrides use the same `tasks`/`tiers` shape in `.sift/models.local.yaml` and win over the config. `sift models` shows the result and where each choice came from.
- A model that is not in a shipped mapping (for example, a local model) is `unqualified` until `sift qualify` (§4.4) assigns it a tier.

### 4.3 Bring-Your-Own-Key Providers

Planned after Phase 1's evaluation baseline exists. All use the user's key from an environment variable or the OS keychain; keys are never written to project files.

| Provider | Covers | Structured output |
|---|---|---|
| `anthropic` | Claude models via the API | Native schema enforcement |
| `openai` | OpenAI models | Native schema enforcement |
| `google` | Gemini models | Native schema enforcement |
| `openai-compatible` | Any endpoint speaking the OpenAI-style API: hosted open-weight models, and local servers (Ollama, LM Studio, vLLM, llama.cpp) | Varies; detected per endpoint |

Behaviour that differs by provider is handled in core, driven by `ProviderCapabilities`:

- **Schema.** With `nativeJsonSchema`, the schema is sent to the provider. Without it, the schema is described in the prompt, and output goes through the normal validation and single retry. The prompt text is otherwise identical.
- **Context budget.** Before sending, core measures the prompt against `contextTokens`. If it is too long, it removes context in this order and records what was removed: related type definitions → doc comments → callee summaries beyond the first level → examples. The unit's own code, structure keys, and detected effects are never removed. If it still doesn't fit, the unit is reported as too large for this model.
- **Split mode.** If a model fails validation on the same unit twice, core retries with the task split into smaller requests: summary and steps first, then warnings in a separate call. This helps small and local models, at the cost of more calls.
- **Privacy notice.** The first run with a non-local provider prints which vendor will receive code; `local: true` providers state that code stays on the machine.

### 4.4 Qualification

`sift qualify <provider>:<model>` runs a fixed qualification subset of the evaluation set (about 20 units covering every construct and planted problem) and reports, per task, whether the model meets the minimum bar. The result is saved to `.sift/models.local.yaml` (git-ignored, since keys and local models are per machine) and assigns the model a tier for routing.

Qualification thresholds (initial; tuned once real results exist): coverage pass rate ≥ 95% after retry, zero invented calls, schema-valid output ≥ 98% after retry, expectation pass rate within 10 points of the recommended tier's.

### 4.5 Provenance

Each unit records what produced it:

```yaml
    generatedBy:
      provider: claude-code
      model: claude-opus-5-5
      prompt: describe@3
      belowTier: false
```

`generatedBy` changes only when the unit is regenerated, so it adds no churn. `sift status` can list units produced below their recommended tier, so they can be regenerated with a stronger model later.

**Team consistency:** the routing overrides in `sift.config.yaml` are committed, so a team shares one routing by default. Personal overrides (for a different key or a local model) go in `.sift/models.local.yaml` and are reported in the run summary, so it is visible when a teammate's descriptions came from a different model.

## 5. Hashing

- **`bodyHash`**: SHA-256 (first 16 hex chars) of the unit's normalized token stream: tokens from the scanner, with comments and whitespace removed, joined with single spaces. Signature is included. Formatting-only and comment-only changes therefore don't change the hash.
- **`fileHash`**: same normalization over the whole file, used for a fast "nothing changed" check.
- **`contextHash`**: hash of the summaries of the unit's callees. If a callee's summary changes, callers' `contextHash` changes, and they are re-checked (§7.3).

Hashes prove "the code is the same", never "the description is right".

### 5.1 Freshness Fast Path

Hashing every file on every command is too slow for `status`, `check`, and graph queries. The cache keeps a fingerprint per source file: `{ size, mtimeMs, fileHash }`.

1. `stat` every included file and compare size and mtime with the fingerprint.
2. Only files whose size or mtime changed (plus new and deleted files) are read and hashed.
3. A file whose hash is unchanged (e.g. touched but not edited) just gets its fingerprint updated.

`--full-hash` (and `SIFT_FULL_HASH=1`) skips step 1 and hashes everything; `sift check` uses it by default in CI (`CI` environment variable set), where mtimes from a fresh checkout are meaningless.

## 6. The `.sift` File (Schema v0)

### 6.1 Example

`.sift/src/accounts/account-service.ts.sift` (the full source path is mirrored under `.sift/`; `.sift/<path>.sift` ↔ `<path>`):

```yaml
sift: 0
source: src/accounts/account-service.ts
language: typescript
fileHash: 4be1c09a7d2e55f0
units:
  - id: u_7f3k2a9q
    symbol: AccountService.transferFunds
    kind: method
    status: generated
    bodyHash: 9c1e04ab33d0e871
    contextHash: 1a02ffe0c4b98d12
    summary: >
      Moves money from one of the requesting user's accounts to another
      account and returns a confirmation of the transfer.
    inputs:
      - name: userId
        type: string
        meaning: ID of the user requesting the transfer.
      - name: fromId
        type: string
        meaning: ID of the account the money comes out of.
      - name: toId
        type: string
        meaning: ID of the account the money goes into.
      - name: amount
        type: number
        meaning: Amount to move, in dollars.
    returns:
      type: Promise<TransferConfirmation>
      meaning: The new balances of both accounts and the time of the transfer.
    effects: [db.read, db.write]
    steps:
      - id: s_q1w8
        text: Get the source account from the database.
        covers: ["0"]
        calls: [u_q9x1p0de]
      - id: s_h3k2
        kind: if
        text: If the source account does not belong to the requesting user,
        covers: ["1"]
        steps:
          - id: s_m9p1
            text: stop with a "forbidden" error.
            covers: ["1.then.0"]
            effects: [throws]
      - id: s_t6n4
        text: Get the destination account from the database.
        covers: ["2"]
        calls: [u_q9x1p0de]
      - id: s_b2v7
        text: >
          Save the source account with its balance reduced by the amount,
          then save the destination account with its balance increased by
          the amount.
        covers: ["3", "4"]
        calls: [u_z3c8m1kf]
        effects: [db.write]
      - id: s_r5y0
        text: Return both new balances and the current time.
        covers: ["5"]
    warnings:
      - id: w_1d4s
        kind: missing-transaction
        text: >
          The two balance updates are not inside a database transaction. If
          the second update fails, money is removed from the source account
          without arriving in the destination account.
        steps: [s_b2v7]
      - id: w_8f2a
        kind: missing-check
        text: >
          There is no check that the source account has enough money or that
          the amount is positive.
  - id: u_m2c8d1aa
    symbol: formatAmount
    kind: function
    lite: true
    status: generated
    bodyHash: 0e7d2c91aa4f3b60
    summary: Formats a number of dollars as a string such as "$1,250.00".
    inputs:
      - name: value
        type: number
        meaning: Amount in dollars.
    returns:
      type: string
      meaning: The formatted amount.
```

### 6.2 Field Reference

**File**

| Field | Source | Notes |
|---|---|---|
| `sift` | core | Schema version. |
| `source` | core | Path relative to project root, forward slashes. |
| `language` | adapter | |
| `fileHash` | adapter | Fast unchanged check. |
| `units` | — | Ordered by source position. |

**Unit**

| Field | Source | Notes |
|---|---|---|
| `id` | core | `u_` + 8 random base32 chars. Never reused. |
| `symbol` | adapter | Qualified name. |
| `kind` | adapter | |
| `lite` | adapter + AI | Present and `true` for lite units. |
| `status` | core | `generated` \| `user-edited` \| `verified` \| `stale`. |
| `bodyHash`, `contextHash` | core/adapter | |
| `generatedBy` | core | Provider, model, prompt version, and whether it ran below the recommended tier (§4.5). |
| `summary` | AI | |
| `inputs[].name/type` | adapter | `typeInferred: true` added when applicable. |
| `inputs[].meaning` | AI | |
| `returns.type` / `.meaning` | adapter / AI | |
| `effects` | rules | Union of step effects plus unit-level ones. |
| `steps` | AI (text) + core (validation) | Omitted for lite units. |
| `warnings` | AI | Each has `kind`, `text`, optional `steps`. |
| `tests` | — | Reserved for Phase 3. |

**Step**

| Field | Source | Notes |
|---|---|---|
| `id` | core | `s_` + 4 base32 chars, unique within the unit. |
| `kind` | AI, checked against structure | Omitted for plain steps; `if`, `else`, `switch`, `case`, `loop`, `try`, `catch`, `finally`. |
| `text` | AI | |
| `covers` | AI, validated by core | Structural keys (§3.1). |
| `calls` | core | Derived from the call sites inside `covers`; unit IDs, or `ext:<module>#<name>`. |
| `effects` | rules | Derived from the call sites inside `covers`. |
| `steps` | AI | Nested steps. |

`calls` and `effects` are never taken from the AI. The AI decides which code a step covers; core then fills in calls and effects from that code. This keeps the facts deterministic and makes Ctrl+click exact.

### 6.3 Serialization Rules

Implemented in `core/sift-yaml.ts`; the full example above is a snapshot test.

- **Fixed key order** (the order in the example), empty lists and absent optional fields omitted. The same data always serializes to the same bytes, and re-serializing a parsed file reproduces it exactly.
- **Prose** (`summary`, `meaning`, `text`) longer than 60 characters, or containing a line break, is a folded block scalar (`>-`); shorter prose is a plain scalar, quoted only if YAML requires it. Line width 80.
- **Lists of plain values** (`effects`, `covers`, `calls`, warning `steps`, `tests`) are written on one line: `effects: [db.read, db.write]`. Everything else, including `generatedBy`, is block style.
- **Rewrites keep unchanged units byte-identical.** The existing file is split into one text chunk per unit (a chunk includes comment or blank lines directly above its `- id:` line). A unit whose content equals the new content keeps its chunk exactly, even if it was hand-formatted or commented; changed and new units are serialized fresh; the header is regenerated. The spliced result is parsed and compared with the intended content, and if it differs (for example, a hand-edited file used a different indentation), the whole file is written fresh instead.
- **No-op writes are skipped:** if the result equals the file on disk, nothing is written, so file timestamps don't change.
- **Writes are atomic:** write to a temp file in the same directory, then rename.
- **Strict validation on read** (`core/validate.ts`): unknown fields, bad ID formats, unknown effects, duplicate IDs, warnings referring to missing steps, and steps on lite units are all reported with their location (e.g. `units[0].steps[1].id: duplicate step id s_q2w6`). A file with a higher `sift` version than this build understands is refused (`SIFT_TOO_NEW`) rather than misread. A file that can't be parsed is never merged into; it is replaced on the next write.

IDs use the base32 alphabet `a–z2–7`.

### 6.4 Lite Units

The adapter marks a unit `isSmall` when it has no control flow, no callbacks, no external calls outside the standard library, and at most 3 statements (§3.2); core clears the flag if rule packs find effects. Small units get a summary and input/return meanings, but no steps. Thresholds are configurable and tuned using the evaluation set.

### 6.5 Cache

`.sift/.cache/` (git-ignored) stores:

- `files/<source path>.json` — per source file, the last `FileExtraction` (ranges, structure, call sites), used only when its `fileHash` and adapter match.
- `fingerprints.json` — size, mtime, and hash per source file (§5.1).
- `graph.json` — the code graph (§10).

It is purely a speed-up: deleting it never loses information, because everything in it can be recomputed from source.

`.sift` files store only **outgoing** calls (in each step's `calls`). Callers are always computed from the graph and never written to a `.sift` file, so editing one file never changes the `.sift` file of another.

## 7. Pipeline

### 7.1 `sift generate`

```text
1. Discover     list source files (respecting .gitignore and sift config excludes)
2. Extract      adapter.extractFile for each file (cache hit if fileHash matches)
3. Load         read existing .sift files
4. Match        pair extracted units with existing units (§7.2)
5. Classify     unchanged / changed / new / deleted per unit
6. Graph        update the code graph (§10); compute SCCs over call edges; topological order (callees first)
7. Describe     for each level, in parallel up to the concurrency limit:
                  new unit       → describe prompt
                  changed unit   → update prompt (§7.4)
                  context changed→ update prompt, "callee summaries changed" only
8. Validate     schema + structural checks (§8); one retry with errors; else mark unit `stale` and report
9. Derive       fill calls, effects, ids; compute contextHash
10. Write       atomic, formatting-preserving write of each changed .sift file
11. Report      counts, failures, warnings, tokens/cost
```

Units in the same strongly connected component (recursion) are described in the same round: each sees the others' signatures but not their summaries. (Describing a component in a single prompt is deferred until the evaluation shows it helps.)

**Milestone 6 scope.** `generate` describes units that have no description yet. A unit whose symbol already has one is kept as it is, and reported if its code changed since; updating it is sync (milestone 7). `--force` describes kept units again, keeping their IDs. `.sift` units whose symbol no longer exists are left in place for sync. Details:

- **IDs up front.** Every new unit gets its ID before any prompt is sent, so a step can refer to a callee described later in the same run.
- **Ordering.** Components are scheduled callees-first and run concurrently up to `concurrency`; a caller waits only for its own callees.
- **fileHash.** A `.sift` file's `fileHash` is updated only when every unit in it matches the current source; otherwise it keeps the old value, so the fast "nothing changed" check never hides a stale unit.
- **Failures** never block other units. A unit that fails is not written; the run exits with code 1.
- `--dry-run` lists each unit with its task and model without calling the AI.

### 7.2 Identity Matching

For each file, extracted units are matched to existing `.sift` units in order:

1. Same `symbol` and same `bodyHash` → same unit, unchanged.
2. Same `symbol` → same unit, changed.
3. Unmatched old unit + unmatched new unit with the same `bodyHash` → renamed (keep `id`).
4. Unmatched pairs with token-level similarity ≥ 0.8 and the same kind → probable rename; keep `id`, mark as changed, and report it.
5. Anything else → old unit deleted, new unit created.

Ambiguous cases (several candidates above the threshold) are not guessed; they become delete + create and are reported.

**File moves:** a `.sift` file whose source no longer exists is matched to a new source file with the same `fileHash` (or ≥ 0.8 unit overlap). The `.sift` file is moved, and IDs are kept.

### 7.3 Context Invalidation

When a unit's `summary` changes, each caller's `contextHash` changes. Callers are then sent a cheap update prompt that only asks: "Given these updated callee summaries, does any step need rewording?" Most answer "no change". This stops staleness from cascading silently without regenerating everything.

### 7.4 Prompts

Both prompts ask for JSON matching a schema; core converts it to YAML. The prompt files are `packages/core/prompts/describe.md` and `describe-lite.md` (lite units: summary, inputs, returns, and warnings only, no structure keys). The user prompt is generated (`core/describe-input.ts`): parameter names in backticks with their types, the code with key markers, a list of every key with its kind and detected effects, and each call with its key, target, signature, summary, implementations, and effects. Code and doc comments pass through secret filtering (§11) first.

**Describe (new unit)** — inputs:
- Unit source, with each structure node labelled by its key as a comment-like marker, e.g. `/*[3]*/ await this.repo.save(from);`.
- Signature, input/return types (marking inferred types).
- Callee list: signature + summary for internal callees; module + member for external ones.
- Rule-pack effects detected per node.
- Relevant type definitions (types of inputs/outputs, one level deep). *Not yet included; added if the evaluation shows descriptions missing type information.*
- Doc comment.
- Style guide: middle-ground vocabulary, describe what the code does (not what it should do), one step per meaningful action, nest steps for control flow, cover every node, describe inline callbacks inside the enclosing step, mark external libraries by name.
- Warning guide: list of warning kinds (missing-transaction, missing-check, missing-auth, unhandled-error, comment-contradicts-code, unawaited-promise, …), and an instruction to only warn on evidence from the code.

Output:

```json
{
  "summary": "...",
  "inputs": [{ "name": "amount", "meaning": "..." }],
  "returns": { "meaning": "..." },
  "steps": [{ "kind": "if", "text": "...", "covers": ["1"], "steps": [ ... ] }],
  "warnings": [{ "kind": "missing-transaction", "text": "...", "covers": ["3", "4"] }]
}
```

**Update (changed unit)** — the same, plus:
- The previous description (with step IDs).
- A unified diff of the unit's old and new source.
- Instruction: keep the text and ID of every step whose code did not change; only edit, add, or remove what the diff requires. Return `id` for retained steps and `null` for new ones.

Steps with `status: user-edited` are flagged in the prompt so their wording is preserved unless it has become wrong; if it has, the unit is marked for review rather than silently rewritten.

### 7.5 Prompt Portability

Prompts are written to work across model tiers and, later, other vendors (requirements §8.3):

- **Files, not strings.** Each prompt lives in `packages/core/prompts/<task>.md` with a version number in its front matter. The version is sent as `promptVersion` and stored with every evaluation result.
- **Correctness comes from validation.** The JSON schema plus the §8 checks are what guarantee output shape and coverage. The prompt explains the rules, but nothing assumes the model followed them.
- **Neutral content.** No pre-filled answers, no vendor-specific markup conventions, no reliance on hidden reasoning being on or off. The provider adds only transport and formatting.
- **Explicit inputs.** Structure keys, types, callee summaries, and detected effects are given in full; the model is never expected to infer them.
- **Two short examples per prompt** (one simple, one with nesting and a warning). Examples help smaller models most; they are kept short so they don't push stronger models toward copying their wording.
- **Concise instructions** stating what is needed and why. No piled-up emphasis ("ALWAYS", "NEVER", repeated warnings), which over-constrains stronger models.
- **Review checklist for prompt changes:** for each model tier and vendor, ask how it is likely to misread the change (a small model skipping nested nodes, a strong model over-elaborating, any model inventing calls not in the code), then confirm with the evaluation matrix.

## 8. Validation

Run after every AI response, before anything is written:

| Check | Rule | On failure |
|---|---|---|
| Schema | Output matches the JSON schema. | Retry once. |
| Valid keys | Every `covers` key exists in the structure tree. | Retry once. |
| **Coverage** | Every structure node is covered by some step (a parent's coverage includes its children). | Retry once; then write with `status: stale` and report `uncovered: [...]`. |
| Kind consistency | A step of kind `if`/`loop`/`try` covers a node of that kind. | Retry once. |
| Effects mentioned | Each node with an effect (db.write, net, fs.write, throws) is covered by a step. | Same as coverage. |
| Inputs complete | `inputs` names match the signature exactly (whitespace ignored, for destructuring patterns such as `{ a, b }`). A destructured parameter described as one input per element, in order, is folded into that parameter instead of retried. | Retry once. |
| Returns | `returns` is present when the unit returns something other than `void`. | Retry once. |
| Warnings | Warning kinds are kebab-case and their `covers` keys exist. | Retry once. |

Implemented in `core/describe-output.ts`. Problems are phrased as instructions the model can act on (`steps[0] covers "9", which is not a structure key of this unit.`). Coverage reports only the outermost uncovered keys. Retries include the exact problems in the prompt. After the retry, a response whose only problem is coverage is written with `status: stale`; any other problem means the unit is not written. Failures never block other units.

**Deriving the unit.** Each structure node belongs to the deepest step that covers it or its nearest covered ancestor. A step's `calls` are the call sites of the nodes it owns: the callee's unit ID, the IDs of every described implementation for a call to an interface member, or `ext:<module>#<name>` for a library. Its `effects` are those nodes' rule effects plus the direct effects of the project units they call (one level, not `throws`, §9). Warnings point at the steps owning their keys.

## 9. Framework Rule Packs

A rule pack is a YAML file mapping call patterns to effects and to graph edges.

```yaml
pack: prisma
version: 1
appliesWhen:
  dependency: "@prisma/client"
rules:
  - match: { module: "@prisma/client", member: "Prisma.*Delegate.{findUnique,findFirst,findMany,count,aggregate}" }
    effect: db.read
  - match: { module: "@prisma/client", member: "Prisma.*Delegate.{create,createMany,update,updateMany,upsert,delete,deleteMany}" }
    effect: db.write
  - match: { module: "@prisma/client", member: "PrismaClient.$transaction" }
    effect: db.transaction
```

- `match.module` / `match.member` are matched against `CallSite.external`. `member` is the **declaration's** qualified name inside its module (§3.2), not the expression as written: `prisma.account.update(…)` is `Prisma.AccountDelegate.update`, whatever the variable is called. Both use glob syntax: `{a,b}` alternatives (which may be empty, as in `{,FileHandle.}readFile`), `*` within one segment (segments are `.` for members and `/` for modules), and `**` across segments. `member` may be omitted to match every member of a module.
- A rule can instead match internal symbols (`match: { symbol: "AuditLog.record" }`) so projects can tag their own wrappers. Symbol rules never match library calls, and module rules never match project calls.
- `appliesWhen.dependency` enables the pack only when the project's `package.json` lists the dependency (in any dependency section). Packs without it always apply.
- Packs are validated strictly when loaded, and every problem is reported at once. Two packs with the same name are an error.

Effect vocabulary (v0): `db.read`, `db.write`, `db.transaction`, `net.request`, `fs.read`, `fs.write`, `process.exec`, `event.emit`, `log`, `throws`.

`throws` comes from `throw` statements, and a rule that tries to give it is rejected. `event.emit` comes from `emits` edge rules (§9.1).

Built-in packs in Phase 1 (`packages/rules/packs/`):

| Pack | Applies when | Matches |
|---|---|---|
| `prisma` | `@prisma/client` is a dependency | Delegate reads and writes, `$transaction`, raw queries, in `@prisma/client` or `.prisma` |
| `node-fs` | always | `fs`, `fs/promises` (and `node:` forms, `FileHandle` methods) → `fs.read` / `fs.write` |
| `node-child-process` | always | `exec`, `execFile`, `spawn`, `fork`, and their sync forms → `process.exec` |
| `fetch` | always | global `fetch` → `net.request` |
| `console` | always | `console.log/info/warn/error/debug/trace` → `log` |
| `express` | `express` is a dependency | `handles-route` edges (§9.1) |

Project packs live in `.sift/rules/*.yaml` and are loaded after built-in ones. The graph records a hash of all applied packs; when any pack changes, every file's graph entry is rebuilt (from cached extractions, so this is cheap).

**Propagation.** Effects propagate one level: if a step calls an internal unit whose direct `effects` include `db.write`, the step gets `db.write` too. A call to an interface member takes the effects of every implementation. This is what lets a service method show "writes to the database" when the actual Prisma call lives in a repository. `throws` is not propagated: an exception is described at the unit that throws it, and a caller's own `try`/`catch` steps say what happens to it.

**Lite units.** Core clears the adapter's lite flag (§6.4) when a unit has any direct effect other than `log`.

### 9.1 Edge Rules

Some connections are invisible to the type checker because they are made at runtime through a library. Edge rules describe them:

```yaml
pack: express
version: 1
appliesWhen:
  dependency: "express"
edges:
  - match: { module: "express", member: "{Router,Application}.{get,post,put,patch,delete}" }
    edge: handles-route
    from: { arg: -1 }            # handler = last argument: a function reference or an inline callback
    route: { method: member, path: { arg: 0 } }
```

```yaml
pack: my-app-events
edges:
  - match: { symbol: "EventBus.emit" }
    edge: emits
    key: { arg: 0 }              # event name, must be a string literal
  - match: { symbol: "EventBus.on" }
    edge: listens
    key: { arg: 0 }
    from: { arg: 1 }
```

- `from: { arg: n }` names the argument that holds the handler: a reference to a project function, or an inline callback; `-1` means the last argument.
- `emits` edges point from the emitting unit to an event node (`event:<key>`), and `listens` edges point from the event node to the handler. Queries walk through the event node, so an emitter's callees include the listeners and a listener's callers include the emitters.
- When the handler is an inline callback, the edge points at the unit that contains it and records the callback's structure key (`handlerKey`). Queries use it to tell routes apart: a route registered in `createRouter` is reached only through calls inside its own callback, not through other routes registered by the same function.
- Arguments that are not literals or resolvable references produce no edge. Those sites are recorded as gaps (§10.3).
- Edges from rules have confidence `rule`.

This requires the adapter to report, for each call site, its arguments in a simple form: string literals, references to units, inline callbacks (by structure key), or `unknown` (`CallSite.args`).

## 10. Code Graph

A core module (`core/graph`) that holds every unit and the relationships between them. It is built from adapter output and rule packs only — no AI — and lives in `.sift/.cache/graph.json`.

### 10.1 Model

Nodes are identified by strings:

| ID | Node |
|---|---|
| `src/a.ts#Class.method` | A unit, or another project declaration such as an interface member or a class without a constructor |
| `ext:<module>#<name>` | A library or platform API (the same form as `.sift` step calls) |
| `route:<METHOD> <path>` | An HTTP route, from edge rules |
| `event:<key>` | An event name, from edge rules |

```ts
interface GraphFile {                         // one per source file
  fileHash: string;
  adapter: string;
  units: { symbol: string; kind: UnitKind; range: SourceRange; lite: boolean; effects: Effect[] }[];
  edges: GraphEdge[];                         // edges recorded in this file
  gaps: GraphGap[];
}

interface GraphEdge {
  kind: "calls" | "implements" | "uses-type" | "handles-route" | "emits" | "listens";
  from: string;
  to: string;
  confidence: "resolved" | "language-server" | "rule" | "name-match" | "inferred";
  sites: { stepKey?: string; range: SourceRange }[];   // one per call site
  effects?: Effect[];                                   // calls: what the rule packs give the call
  handlerKey?: string;                                  // handles-route, listens: inline callback (§9.1)
}
```

`units[].effects` are the unit's **direct** effects; propagated effects (§9) are computed when asked for. Units are linked to `.sift` unit IDs through the `.sift` files (by symbol, §7.2), not in the graph.

Sources of edges in Phase 1:

| Edge | Source | Confidence |
|---|---|---|
| `calls` | `CallSite.target` or `CallSite.external` | `resolved` (TS checker) or `name-match` |
| `implements` | `ExtractedUnit.implementsMember` | `resolved` |
| `uses-type` | `ExtractedUnit.typeRefs` | `resolved` |
| `handles-route`, `emits`, `listens` | Edge rules (§9.1) | `rule` |
| `tests` | Phase 3 | — |

A call through an interface is stored once, as a `calls` edge to the interface member. Dispatch to the implementations is worked out at query time from the `implements` edges, so adding a new implementation in another file never leaves an unchanged caller's edges out of date. Results reached this way say which member they were dispatched through.

`language-server` and `inferred` are reserved for the generic adapter and for AI-proposed edges later.

### 10.2 Incremental Updates

Every read-only command first runs the freshness fast path (§5.1) and then refreshes the graph:

1. A file whose hash differs from its graph entry (or that is new) is rebuilt. Files that no longer exist, or are no longer included, are dropped.
2. Unchanged files with an edge into a changed or dropped file are rebuilt too, because the type checker may now resolve their calls differently (for example, the method they called was renamed). Their extraction cache is bypassed.
3. Extractions come from the cache (§6.5) when the hash matches. The adapter's project, the slow part, is opened only when something must actually be re-extracted, and then once for all files.

After a rename, a caller's call no longer resolves and shows up as a gap, which `sift status` (milestone 7) will report. An incremental refresh produces the same graph as a full rebuild in these cases, and a test checks this.

Known limit: an unchanged file whose call was *unresolved* is not rebuilt when a new file makes that call resolvable. Deleting the cache, or any change to that file, fixes it.

### 10.3 Gaps

The graph records what it could not resolve:

- `unresolved-call`: call sites with neither a target nor a library (calls through function-typed variables, `any`-typed receivers).
- `unknown-route`, `unknown-event`, `unknown-handler`: route or event registrations whose path, key, or handler was not a literal or a resolvable reference.
- `emits` keys with no listener, and listeners with no emitter (`unmatchedEvents`).

Queries say when a result may be incomplete, so a missing caller is never mistaken for proof that there is none:

- `callers` and `impact` list unresolved call sites whose callee name matches the subject's last name part (`this.handlers.save(x)` for `Repo.save`) as possible callers.
- `callees` lists the subject's own unresolved calls.
- `impact` lists registrations it could not read inside the affected units.

### 10.4 Queries

| Query | Result |
|---|---|
| `find(name)` | Symbols matching `file#Symbol`, a qualified name, or its last part(s). Exact matches win; several matches are an error that lists them. |
| `callers(unit, depth)` | Units that call it, transitively up to `depth`: direct calls, calls to an interface member it implements, emitters of events it listens to, and routes it handles. |
| `callees(unit, depth)` | What it calls: units and declarations, the implementations of interface members it calls, library calls with their effects, and the listeners of events it emits. |
| `effectsOf(unit, propagated)` | Direct effects, or with one level of propagation (§9). |
| `impact(units)` | Everything upstream of the given units: callers, emitters, then the routes and (Phase 3) tests reached. At the same distance, the strongest path wins. |
| `impactOfDiff(gitRef)` | Maps changed line ranges in `git diff --relative <ref>` (working tree against the ref) to units, then runs `impact`. Pure deletions mark the lines around them. |
| `flow(route)` | Units reachable downstream from a route handler, with effects at each step. Milestone 6. |
| `scc()` / `topoOrder()` | Used by the pipeline (§7.1). Milestone 6. |

`impact` output groups results by kind (routes, units, tests) and shows each path's weakest edge confidence, so a result that depends on a `name-match` edge is visibly weaker.

## 11. Secret Filtering

Before any prompt is sent:

- Files matching `.env*`, `*.pem`, `*.key`, and paths listed under `exclude` in `sift.config.yaml` are never read into prompts.
- Prompt source and doc comments are scanned for known secret formats (AWS, GitHub, Anthropic/OpenAI-style, Slack, Google, Stripe keys, JWTs, private-key blocks), and string literals for high-entropy values (length ≥ 20, no spaces, not a path or URL, at least two character classes, ≥ 4 bits of entropy per character); matches are replaced by `"<redacted>"` (`core/redact.ts`).
- The number of redactions is reported. Redaction never changes source files or hashes.

## 12. CLI

| Command | Does | AI calls |
|---|---|---|
| `sift init` | Creates `.sift/`, `sift.config.yaml`, adds `.sift/.cache/` and `.sift/models.local.yaml` to `.gitignore`. | No |
| `sift generate [paths…]` | Runs the pipeline (§7) for the given files or folders, or the whole project. `--dry-run` lists units and models without calling the AI; `--force` describes units again, keeping IDs; `--json` prints the run report. Exits 1 if any unit failed. | Yes |
| `sift status` | Lists stale, new, deleted, unverified, and failed-validation units. | No |
| `sift check` | Like `status`, but exits non-zero if anything is stale or missing. For CI and hooks. | No |
| `sift show <symbol\|file>` | Prints a readable rendering of a unit (nested outline, warnings). | No |
| `sift callers <symbol> [-d N]` | Units and routes that call it, with edge confidence, as a tree. | No |
| `sift callees <symbol> [-d N]` | Units and library calls it makes, with effects (propagated one level), and its unresolved calls. | No |
| `sift impact <symbol…> \| --diff <ref>` | Units, routes, and tests that may be affected by changing the given units, or by the changes since a git ref. | No |
| `sift eval` | Runs the evaluation harness (§13). `--matrix` runs the model matrix (§13.4). | Yes |
| `sift qualify <provider>:<model>` | Runs the qualification subset and assigns the model a tier (§4.4). | Yes |
| `sift models` | Shows the active routing: task → tier → model, overrides, and qualified local models. | No |

All read-only commands run the freshness fast path (§5.1) first and refresh the graph if needed (§10.2), so results are never stale. `--json` is available on every query command for scripts and, later, the MCP server; `--full-hash` is available on every command that refreshes the graph. Symbols are given as `file#Symbol`, `Class.method`, or a unique last part such as `transferFunds`.

`sift.config.yaml`:

```yaml
include: ["src/**"]
exclude: ["**/*.test.ts", "**/generated/**"]
provider: claude-code
concurrency: 4
lite: { maxStatements: 3 }
models:                         # optional, committed: shared by the team (§4.2)
  tasks:
    describe: mid               # run a task on a different tier
  tiers:
    small: { model: claude-sonnet-5-5, effort: low }   # remap a tier
```

## 13. Evaluation Harness

### 13.1 Fixture: `eval/fixtures/bank-app`

A small TypeScript + Prisma + Express application written for evaluation. It only needs to type-check, never to run: Prisma, Express, and JSX are stubbed with ambient declarations in `types/`, so the fixture needs no install or code generation. Its README lists the planted problems and the shapes it covers.

- `AccountService` (transfer, deposit, withdraw, list), `AccountRepository` interface with `PrismaAccountRepository` and `InMemoryAccountRepository`.
- `AuthService` with an authentication check.
- Express routes calling the services, and an event bus (`transfer.completed` → notification listener) for edge rules.
- Planted problems: transfer without a transaction; withdraw without a balance check; one endpoint without an ownership check; an un-awaited promise; a comment that contradicts its code.
- Shapes: inline callbacks, small helpers, a recursive function, a React component, async try/catch, a switch, a module-level registration.
- Vitest tests (used in Phase 3; present now so the fixture is realistic).

### 13.2 Expectations

`eval/expectations/<fixture>.yaml`, one entry per unit, keyed by `file#symbol`:

```yaml
fixture: bank-app
units:
  - unit: src/accounts/account-service.ts#AccountService.transferFunds
    mustMention:                 # ideas, matched by the judge, so paraphrases count
      - stops with a forbidden error if the user does not own the source account
      - saves both accounts
    mustWarn: [missing-transaction, missing-check, unawaited-promise]
    mustNotWarn: [missing-auth]
  - unit: src/accounts/money.ts#formatCents
    lite: true                   # expected to be a lite unit
    mustMention: [formats cents as a dollar string]
```

### 13.3 Metrics

| Metric | How |
|---|---|
| Coverage pass rate | From validation (§8). |
| Missed effects | Effect-bearing nodes not covered. |
| Expectation pass rate | `mustMention` (AI judge for paraphrases) + `mustWarn` / `mustNotWarn`. |
| Accuracy | AI judge with a rubric (correct / minor issue / wrong), human spot checks. |
| Churn | Run `generate --force` on unchanged code; then apply small scripted edits (rename a variable, add a log line, change a condition) and measure the fraction of unrelated steps whose text changed. Target: 0 for unchanged code. |
| Cost / latency | From provider usage. |

Results are written to `eval/results/<timestamp>.json` with a short Markdown summary, so prompt changes can be compared run to run.

### 13.4 Model Matrix

`sift eval --matrix` runs every task's prompt across a set of models, each combination `--repeat N` times (default 3). The default set, `eval/matrix.yaml`:

- For each task: its recommended tier and the next tier down, for every provider that has a key configured.
- At least one capable local model through `openai-compatible`, once that provider exists.
- Any model passed with `--add <provider>:<model>`.

The results are what the per-provider mapping files (§4.2) and the qualification thresholds (§4.4) are based on.

The summary is a table per task:

| Prompt | Model | Coverage | Missed effects | Expectations | Accuracy | Churn | Variance | Cost / unit | Latency |
|---|---|---|---|---|---|---|---|---|---|

plus a list of **failure patterns per model** (which nodes were skipped, which calls were invented, which instructions were ignored), taken from the validation failures and judge notes.

Rules:

- A prompt change is adopted only if no model in the matrix regresses noticeably, or the regression is accepted deliberately and noted in the results.
- **Judge independence.** With a single provider, the frontier model judges output from its own model family. Those scores are marked `self-graded`, and decisions rest more on the deterministic metrics (coverage, missed effects, `mustWarn`) and human spot checks. Once a second provider has a key configured, the judge is taken from a different vendor than the model under test, and both judges are run on a sample to measure how much they disagree.
- When a provider is added, its models join the matrix before its mapping file is published.

## 14. Engine Testing

- **Adapter:** snapshot tests of `FileExtraction` for small source samples (each construct, JS vs TS, inferred types, interface implementations, external calls).
- **Core:** unit tests for hashing, freshness fingerprints, identity matching, coverage validation, rule matching, serialization round-trips (byte-identical rewrite when nothing changed), atomic writes, secret redaction.
- **Graph:** edges and confidence over the fixture (interface dispatch, Express routes, events); incremental rebuild after editing one file equals a full rebuild; gaps reported; `impact --diff` on scripted git changes.
- **Pipeline:** end-to-end with `FakeProvider` over the fixture: generate, edit code, regenerate, assert only expected units changed and IDs were preserved; simulate a file move and a rename.
- **Provider:** contract test that runs against the real `claude -p` only when an environment flag is set.

## 15. Milestones

1. **Skeleton** — monorepo, packages, CLI wiring, `sift init`, config loading.
2. **Extraction** — TS adapter: units, structure tree, keys, types, hashes, call resolution, implementations, external calls. `sift show --structure` to inspect.
3. **Schema and storage** — schema types and strict validation, YAML serializer with byte-stable rewrites, `.sift` store, IDs, extraction and fingerprint cache, `sift show` for `.sift` files.
4. **Rule packs and graph** — rule loader and matcher, built-in packs, effect propagation, edge rules, code graph, freshness fast path, `callers` / `callees` / `impact`.
5. **Fixture** — bank-app and expectations (built alongside M2, since it is also the adapter's test input).
6. **Generation** — provider interface, Claude Code provider, describe prompt, validation and retry, `sift generate` for new units.
7. **Sync** — identity matching, update prompt, context invalidation, file moves, `status`, `check`.
8. **Evaluation** — harness, metrics, first baseline; then iterate on prompts.

Milestones 1–5 involve no AI calls and can be built and tested completely before any prompt work begins.

## 16. Decisions Deferred Within Phase 1

- Exact similarity threshold for rename detection (start at 0.8, tune on the fixture).
- Lite-unit thresholds.
- Whether `module` units are worth describing in v0 or should wait.
- Whether to batch several small units into a single prompt for cost.
- Model selection per task once the provider supports it.
- Whether `uses-type` edges should include types used only inside a body, or only those in signatures (noise vs. completeness).
