# Sift — Product Requirements

## 1. Product Overview

### 1.1 Product Summary

Sift is an AI-native development environment in which users understand, review, and modify software primarily through editable natural-language representations of its logic.

Source code is the source of truth. Sift derives a persistent, human-readable logic representation from the source code and stores it in version-controlled `.sift` files. Users read software behavior in plain language and request changes by editing that language. Each natural-language edit is treated as a change request against the code: AI makes a targeted source-code change, the change is validated, and the result is shown for review. The logic representation is then re-derived from the updated code.

The product is designed to support multiple programming languages. The natural-language representation describes behavior and intent independently of whether the implementation uses TypeScript, Python, Go, Java, or another supported language. Language support is added incrementally through language adapters.

### 1.2 Product Vision

Make software easier to understand, review, and modify by allowing people to work at the level of logical behavior rather than programming-language syntax.

The long-term vision is an IDE in which natural language is a primary way to interact with software, while conventional source code remains the real, executable implementation.

### 1.3 Target Audiences

The product may ultimately serve three audiences:

1. **Non-technical builders and founders**
   - People who use AI to create applications but want more understanding and control over what has been built.
   - People who want to make changes and gradually learn software concepts without first learning the syntax of a programming language.

2. **Developers who use AI coding agents**
   - Developers who use AI to generate substantial amounts of code.
   - They want to review what AI has implemented, understand behavioral changes, and catch problems without manually reading every implementation detail.

3. **Experienced developers and technical reviewers**
   - Developers who want to reason about business logic, system behavior, and architecture at a higher level.
   - They want to navigate and review software through concise logical representations while retaining access to the underlying implementation.

**Initial audience:** Developers who regularly use AI coding agents are the working initial audience, because they already understand software concepts and have an established need to review AI-generated changes. This remains a hypothesis to validate.

**Vocabulary:** Descriptions use a middle-ground vocabulary: plain enough for a non-specialist to follow, precise enough that a developer does not lose meaningful detail. Technical terms (transaction, asynchronous, null) are used when they carry meaning, not avoided at the cost of accuracy.

### 1.4 Core Value Proposition

- **Understandability:** Read software behavior in plain language.
- **Natural-language editing:** Change behavior by editing the description of what a function does.
- **Language independence:** Express behavior without needing to know how each programming language implements it.
- **Traceability:** Connect logical descriptions to source code, called functions, tests, errors, and dependencies.
- **Safer AI-assisted development:** Make targeted changes, inspect diffs, and validate generated code.
- **Persistent logic representation:** Store natural-language logic and supporting metadata in version-controlled project files that both people and other AI agents can read.

---

## 2. Product Principles

1. Source code is the source of truth. `.sift` files are a derived, persistent, editable representation of it.
2. Natural language is a primary interface for understanding and requesting changes to program behavior.
3. The product must not imply that a natural-language description is correct merely because an AI generated it.
4. Anything that can be determined deterministically (by parsers, compilers, or type checkers) is determined that way. AI is used only for what requires interpretation: purpose, meaning, and prose.
5. Small natural-language edits should produce targeted implementation changes, not regeneration of entire functions.
6. Users must be able to inspect the source code and the exact changes made by the system.
7. The product distinguishes between what the code currently does, what the user intends, what the AI proposes, and what has been verified.
8. Language-specific details are handled by the system where possible, without hiding meaningful behavior or trade-offs.
9. The system preserves user control. Generated changes are reviewable and are not silently applied when they can materially change behavior.
10. Logic representations must remain useful across machines, Git operations, and development workflows.
11. Reliable derivation, synchronization, and traceability come before the visual editor.

---

## 3. Core User Experience

### 3.1 Logical Units

Each supported source file is broken into logical units. A unit is one of:

- **Full unit:** Functions, methods, class constructors, and UI components. These receive a complete logic representation (summary, inputs, outputs, steps, effects, warnings).
- **Lite unit:** Small named helpers whose behavior is fully conveyed by a one- or two-sentence summary. These receive a summary, signature, and links, but no step list.
- **Inline logic:** Anonymous callbacks and inline functions (for example, the function passed to `.map`) are not separate units. Their behavior is described inside the step of the enclosing unit that uses them (for example, "For each account, add its balance to the total").

Module-level code that performs work (initialization, registration, configuration) should be represented when it has meaningful behavior.

### 3.2 Logic Representation

For each full unit, the representation communicates:

- Name and kind (function, method, component).
- Purpose and behavioral summary.
- Inputs: names, source types, and plain-language meaning.
- Outputs: source return type and plain-language meaning.
- Ordered execution steps, structured as a tree: conditions, branches, loops, early returns, and error handling appear as nested steps rather than being flattened into prose.
- Side effects, such as database reads and writes, network calls, file operations, and emitted events.
- Error and failure behavior.
- Links from steps to the functions they call.
- Links to associated tests.
- Links to the corresponding source code.
- Warnings and recommendations (see 3.7), kept separate from the description.
- Status (see 3.8).

There is no target number of steps. A description must contain enough detail to know exactly what the function does. It must not omit important operations to appear shorter, and it must not pad simple functions.

**Types:** Types are shown as the source type plus a plain-language meaning (for example, `number` — amount in dollars). In languages with weak or optional typing, such as JavaScript, inferred types are marked as inferred.

**External calls:** Calls into third-party libraries or platform APIs (for example, Prisma, axios, `fetch`) have no `.sift` file to link to. Steps describe them using general knowledge of the library and mark them as external.

### 3.3 Presentation

The leading presentation concept is a **logic document**: each source file opens as one continuous, editable document.

- Each unit is a collapsible section.
- Steps appear as a nested outline, indented the way code is.
- References to other units are links.
- A status badge in the margin shows whether each unit is stale, unverified, user-edited, or verified.
- The source code can be opened side by side; hovering a step highlights its source.
- Card-style presentations of a single unit may be used where a compact view is useful, such as hover previews and search results.

The presentation is an open design decision (see 14.4) and is not needed for the first phase, which is CLI-only. The underlying data model supports any of these presentations.

### 3.4 Step Navigation (Go to Definition)

Users can Ctrl+click (or equivalent) a step to navigate to the logic of the function that step calls, in the same way that IDEs navigate to the definition of a class or method.

Example: a step in a service reads "Get the user's accounts from the database." Ctrl+clicking it opens the description of `AccountRepository.getAccounts`, which reads "Query the accounts table for all accounts owned by the user."

- Call targets are resolved by language tooling (the compiler or language server), not guessed by AI.
- When a call goes through an interface or abstract type with a single implementation, navigation goes directly to that implementation.
- When there are multiple implementations, the user picks one, similar to "Go to Implementation" in conventional IDEs.
- A secondary action navigates to the source code of the called function.
- External calls show their external description rather than navigating.

### 3.5 Natural-Language Editing

Users can edit the natural-language content directly, much like editing text in a document.

Example original description:

> Retrieve the user's account from the database and return an object containing a Double for the account balance and a String for the username.

Example user edit:

> Retrieve the user's account from the database and return an object containing a BigDecimal for the account balance and a String for the username.

An edit is a **change request against the code**, not a direct modification of the source of truth. The system determines the intended behavioral change, makes a targeted source-code change, validates it, and presents it for review. Once applied, the logic representation is re-derived from the new code. User-written wording that accurately describes the new behavior is preserved.

The editing experience does not require manipulating a predefined visual block for every operation. Structured controls may be offered when useful, but direct natural-language editing is central.

### 3.6 Targeted Changes

When a user edits the logic representation, the workflow is:

1. Identify what changed in the natural-language representation.
2. Identify the affected steps, inputs, outputs, types, and dependencies.
3. Locate the corresponding implementation through the step-to-source mapping.
4. Make the smallest reasonable source-code change that implements the edit.
5. Preserve unrelated behavior and implementation details.
6. Run relevant validation.
7. Present the source diff and validation results for review.

If a change genuinely requires broader modifications, the system explains why and shows the full scope of the proposed change.

### 3.7 Warnings and Recommendations

The system warns when behavior that is normally expected is missing — either from existing code or from a user's natural-language edit.

Example: a function transfers funds between accounts, but the two balance updates are not inside a database transaction (or the user's edit describing a transfer does not mention a transaction).

- Warnings are stored and displayed separately from the description. The description states what the code does; warnings state what might be missing or risky.
- Warnings apply to existing code from the first phase onward, not only to edits.
- When a warning leads to a clarifying question and the user answers it (for example, confirming that a transaction is wanted), the answer is implemented in the code and the natural-language description is updated to mention it explicitly.

### 3.8 Status and Provenance

Every unit and step carries a status:

- **generated** — produced by AI from the current code; not verified.
- **user-edited** — wording written or revised by a user.
- **verified** — confirmed by a user or by validation evidence.
- **stale** — the source code has changed since the description was produced.

The interface must always make clear when a description has not been verified against the current source code.

### 3.9 Code Graph and Project-Level Navigation

Sift maintains a graph of the codebase in which every logical unit is a node and relationships between units are edges. Users navigate software by functionality and relationships, not only by files and folders.

**Nodes** are logical units (functions, methods, components). File-level and folder-level views are rolled up from unit-level nodes.

**Edges:**

- **Calls** — one unit calls another.
- **Implements** — a class method implements an interface or abstract member.
- **Uses type** — a unit takes, returns, or constructs a shared data type.
- **Handles route** — a unit is registered as the handler of an API endpoint.
- **Emits / listens** — a unit emits an event that another unit listens to.
- **Tests** — a test covers a unit (Phase 3).

**Edge confidence:** every edge records how it was established, and the interface shows the difference:

- **Resolved** — determined by the compiler or type checker.
- **Language server** — determined by a language server.
- **Rule** — established by a framework rule pack (for example, route registration).
- **Name match** — matched by name only, without type information.
- **Inferred** — proposed by AI.

The graph must not appear more complete than it is. Connections invisible to static analysis — dependency-injection containers, dynamic calls, raw HTTP between services — are acknowledged as possible gaps.

**Uses of the graph:**

- **Forward and reverse navigation:** from a step to the units it calls (3.4), and from any unit to its callers.
- **Impact analysis:** given a unit or a diff, show every unit, endpoint, and test that may be affected. This supports reviewing changes made by AI coding agents ("this change touched three functions, which affect these two endpoints") and scoping natural-language edits (11.5).
- **Flows:** follow a path from an entry point such as an API endpoint down through services and repositories to the database.
- **Generation order and context:** callees are described before callers, and AI context is selected by walking the graph (5.2, 8.5).
- **Effect propagation:** a unit that calls a database-writing unit is itself shown as writing to the database (6.2).
- **Invalidation:** when a unit's summary changes, its callers are re-checked (5.5).

**Presentation:** the value of the graph lies in focused views — a unit's neighbourhood, one flow, the impact of one change — not in a picture of the entire codebase, which becomes unreadable beyond a few dozen units. A whole-project map, if offered, should group units into AI-proposed concepts (for example, "Transfers" or "Authentication") and is subject to validation (15.4).

The graph is deterministic and derived entirely from source code, so it is stored in the uncommitted cache and rebuilt incrementally. AI-proposed concept groupings, being interpretation rather than fact, may be committed.

---

## 4. The `.sift` Logic File

### 4.1 Purpose

A `.sift` file stores the natural-language logic and the metadata that connects it to source code. It is a persistent, editable, version-controlled project artifact — not disposable documentation or a cache of AI summaries.

`.sift` files are designed to be readable by other AI coding agents as well as by people, so they can serve as project context for tools outside Sift.

### 4.2 Layout

There is one `.sift` file per source file, mirroring the source tree under a `.sift/` directory at the project root:

```text
my-app/
├── src/
│   ├── accounts/
│   │   ├── transfer.ts
│   │   └── accounts.ts
│   └── users/
│       └── authenticate.ts
│
├── .sift/
│   ├── accounts/
│   │   ├── transfer.ts.sift
│   │   └── accounts.ts.sift
│   ├── users/
│   │   └── authenticate.ts.sift
│   ├── rules/            # project framework rule packs (committed)
│   └── .cache/           # derived data (not committed)
│
└── tests/
```

### 4.3 Serialization

`.sift` files are YAML, chosen for ease of parsing and readable diffs. The application presents them in an editable, document-like form; users are not expected to edit YAML directly.

Serialization rules:

- Prose is always written as YAML block scalars.
- Keys are always written in a fixed order.
- Files are rewritten with a formatting-preserving YAML library so that unchanged content stays byte-identical.
- Every file declares a schema version.

### 4.4 Deterministic and AI-Generated Content

Each `.sift` file contains two kinds of content:

| Deterministic (from language tooling) | AI-generated |
|---|---|
| Unit symbol, kind, signature | Summary and purpose |
| Source types of inputs and outputs | Plain-language meaning of inputs and outputs |
| Normalized body hash | Step text |
| Call targets (links to other units) | Descriptions of conditions, loops, and errors |
| Side effects (from language and framework rules) | Warnings and recommendations |
| Structure: branches, loops, returns, throws | |
| Source ranges | |

AI-generated content is validated against deterministic content. If the deterministic layer detects a side effect, call, or throw that no step covers, the unit is flagged.

### 4.5 Information Stored

A `.sift` file stores, per unit:

- Stable opaque identifier.
- Symbol name and kind.
- Normalized body hash, used to detect staleness.
- Status and provenance, including the provider and model that produced the description.
- Summary.
- Inputs and outputs (source type and meaning).
- Side effects.
- A tree of steps, each with a stable identifier, text, kind (plain step, condition, loop, error handling), outgoing call links, and effects.
- Warnings.
- References to tests.

And per file: schema version, source path, language, and source file hash.

`.sift` files store only **outgoing** relationships (the units a step calls). Incoming relationships such as callers are computed from the code graph (3.9) and never stored, because they change whenever other files change; storing them would cause churn and merge conflicts in files that were not edited.

### 4.6 Stable Identifiers and Source Mapping

Units and steps have stable, opaque identifiers that do not depend on names or line numbers. Names are stored separately, so renaming a function does not change its identity.

- When code changes, the system matches units to their previous identity by symbol name, then by structural and hash similarity. Ambiguous matches are flagged, never guessed silently.
- When a source file is moved or renamed, the system detects the move by content and moves the `.sift` file with it, preserving identifiers.
- Each step maps to one or more source ranges, and a source range may belong to more than one step. The system must not assume that a sentence maps to one contiguous range.
- **Coverage rule:** every meaningful statement in a unit must be covered by at least one step, and every step must map to real code. Units that fail this check are flagged.
- Exact source ranges change on every edit, so they are stored in the uncommitted cache and recomputed. The committed file stores only what is needed to recover them and to detect staleness.

### 4.7 Incremental Regeneration

When a unit's code changes, the system updates its existing description rather than regenerating it from scratch. The AI receives the previous description and the code change and is asked to make the minimum edit, preserving the wording and identifiers of steps whose code did not change.

This keeps `.sift` diffs small and meaningful, preserves user-edited wording, and keeps navigation links stable.

### 4.8 Version Control

`.sift` files are committed to Git alongside source code. The product must handle:

- Readable, minimal diffs.
- Stable ordering.
- Merge conflicts in `.sift` files (in a source-first model, conflicts can always be resolved by re-deriving from the merged source, while preserving user-edited wording where it still applies).
- Schema versioning and migration of older files.
- Detection of stale `.sift` files after branch switches, pulls, merges, and rebases.

---

## 5. Synchronization and Change Management

### 5.1 Model

Source code is authoritative. Synchronization is one-directional derivation plus change requests:

- **Code → logic:** whenever source changes (from a developer, an external AI agent, or Git), affected units are detected and their descriptions are updated or marked stale.
- **Logic → code:** a natural-language edit becomes a change request. It produces a proposed source change; once applied, the logic is re-derived from code.

### 5.2 Code-to-Logic Workflow

1. Detect changed files and units.
2. Parse the updated source with the language adapter.
3. Identify added, modified, deleted, and moved units.
4. Compare normalized hashes and structure.
5. Recompute the deterministic layer.
6. For units whose behavior may have changed, update the AI-generated layer incrementally (see 4.7).
7. Preserve stable identifiers when the same unit can be confidently identified.
8. Flag ambiguous matches and units that could not be updated.
9. Mark any description that has not been regenerated against current code as stale.

Units are processed in dependency order (callees before callers) so that each unit's description can use the summaries of the functions it calls. Recursive and mutually recursive groups are handled using signatures in place of missing summaries.

### 5.3 Logic-to-Code Workflow

1. Load the current `.sift` file and associated implementation.
2. Identify the exact text change.
3. Determine affected units, types, callers, dependencies, and tests.
4. Provide the AI with relevant context: imports, type definitions, callee signatures and summaries, surrounding code, project conventions.
5. Request a targeted implementation change.
6. Validate syntax and types.
7. Run relevant tests and diagnostics.
8. Show the source diff, the resulting logic diff, and validation results.
9. Apply the change only according to the user's approval settings.
10. Re-derive the logic from the applied code.

### 5.4 Pending Edits and Concurrent Changes

If a user has an unapplied natural-language edit and the underlying code changes, the edit is marked as needing review against the new code. It is never silently discarded or silently applied to code it was not written against.

### 5.5 Change Detection and Caching

The system avoids unnecessary AI calls through:

- Parsing and normalized, unit-level hashes.
- Structural comparison.
- Cached descriptions.
- Dependency-aware invalidation (a callee's summary changing may affect its callers' descriptions).

Whitespace and comment-only changes do not trigger regeneration.

Freshness checks must feel instant. The system first compares file size and modification time against the last build and hashes only files that appear changed. A full-hash mode is available for CI and for cases where timestamps are unreliable.

Hashes and successful parsing are never treated as proof that a description is behaviorally correct.

### 5.6 Checking in CI and Hooks

The command-line tool can verify, without making AI calls, that every `.sift` file matches the current source. This allows drift checks in CI and pre-commit hooks — particularly valuable when AI coding agents change code.

---

## 6. Language Support Architecture

### 6.1 Goal

Users should be able to describe behavior without knowing how a particular language implements it — for example, "Start a database transaction" or "Verify that the user owns the account." The implementation may differ by language, framework, library, or project convention.

The system preserves meaningful type distinctions and does not assume that similarly named types across languages behave identically. Changing `Double` to `BigDecimal`, for example, should prompt consideration of affected calculations, conversions, database mappings, serialization, callers, and tests.

### 6.2 Core and Adapters

The system has three layers:

1. **Core (language-independent):** `.sift` schema, identifiers, hashing and staleness, cache, AI pipeline and provider interface, validation (including the coverage rule), and the command-line interface. The core never parses source code itself and never depends directly on any language's compiler.

2. **Language adapters:** each adapter answers a fixed set of questions about source code:
   - Which units exist in a file?
   - What is the structure inside each unit (statements, branches, loops, error handling, returns, throws)?
   - What does each call resolve to, including implementations behind interfaces?
   - What are the input and output types?
   - What is the normalized form for hashing?
   - What source range does each element cover?

   Adapter inputs and outputs are plain data, so adapters could later run out of process or be written in other languages.

3. **Framework rule packs:** data-driven rules that recognize library-specific operations. Rules produce two kinds of facts:
   - **Effects** — for example, "a call to `prisma.<model>.update` is a database write."
   - **Edges** — connections the type checker cannot see, for example, "`app.post(path, handler)` registers `handler` as the handler of that route," or "`emitter.emit('transfer')` reaches the listeners registered with `emitter.on('transfer', …)`."

### 6.3 Language Support Levels

| Level | What it provides | Examples |
|---|---|---|
| Built-in deep adapter | Full types, accurate call and implementation resolution, effect detection | TypeScript/JavaScript (first), Python (next) |
| Generic adapter (Tree-sitter + language server) | Structure for any language with a grammar; semantics as good as that language's server provides | Go, Java, Rust (later) |
| Framework rule packs | Side-effect detection and graph edges for specific libraries | Prisma, Node `fs`, `fetch`, Express routes (first); user-defined |

TypeScript and JavaScript share one adapter built on the TypeScript compiler.

### 6.4 Extensibility

- First-party language adapters ship built in, but implement the same interface that a plugin would.
- The language adapter interface remains private until a second language (Python) has validated it. A public plugin API is not offered before then.
- Framework rule packs are the first user-facing extension point. Built-in packs ship with the product; projects can add their own in `.sift/rules/`.

### 6.5 Concepts

The system should understand common programming concepts independently of syntax:

- Primitive and composite data types.
- Objects, records, and structures.
- Collections.
- Functions and methods.
- Conditions and loops.
- Exceptions and error handling.
- Database operations and transactions.
- Authentication and authorization.
- API requests and responses.
- Asynchronous operations.
- File and external-system operations.

Language support requires more than parsing syntax. Each adapter must understand type systems, runtime behavior, libraries, and common patterns well enough to support accurate descriptions and correct generated code.

---

## 7. Testing, Debugging, and Error Mapping

### 7.1 Test Association

`.sift` files store references to relevant tests. A unit may be associated with multiple tests, and a test may cover multiple steps or units.

Users can navigate between:

- A unit and its tests.
- A failing test and the relevant unit.
- A failing step and its source code.
- A source-code diagnostic and its logical representation.

### 7.2 Test Failure Mapping

When a test fails, the IDE should:

1. Identify the failing test and its failure details.
2. Use stack traces, source maps, coverage, instrumentation, or other evidence to locate relevant source code.
3. Map the source location to the corresponding unit and step.
4. Highlight the relevant unit or step.
5. Display the failure explanation and test information.
6. Allow the user to inspect the source and ask AI to investigate.

When a failure cannot be mapped precisely, the product says so. An inferred mapping is never presented as definitive.

### 7.3 Example

A transfer test expects an insufficient-funds error, but the transfer succeeds.

**Transfer funds — test failing**

- Authenticate the requesting user. — Passed
- Verify ownership of the source account. — Passed
- Check that the source account has sufficient funds. — Associated with failing test
- Start a database transaction.
- Subtract the transfer amount from the source account.
- Add the transfer amount to the destination account.

Associated test: `transfer-insufficient-funds`

The user can navigate to the test, the relevant source code, or an AI investigation.

### 7.4 AI-Assisted Debugging

1. Explain the observed failure.
2. Identify the relevant steps and implementation.
3. Propose a targeted change.
4. Show the proposed source diff.
5. Run the relevant test and other appropriate validation.
6. Report whether the fix passed, failed, or remains unverified.

A fix is never described as successful until validation has actually completed.

---

## 8. AI Integration

### 8.1 Provider Interface

All AI calls go through a provider interface so that providers and models can be swapped without changing the rest of the system.

- The first provider invokes the Claude Code CLI in headless mode (`claude -p`), using the user's own subscription.
- Later providers support Bring Your Own Key (BYOK): the Anthropic API, other commercial vendors (such as OpenAI and Google), and OpenAI-compatible endpoints, which also cover locally hosted open-weight models.
- Each AI task is routed to a configurable model, so cheaper models handle simple tasks and stronger models handle hard ones.

Improving description quality is done by iterating on prompts and the generation pipeline, measured against the evaluation set (section 12), not by training or fine-tuning models.

### 8.2 Model Recommendations

Because users may bring their own keys, recommendations are expressed as **capability tiers**, not specific models. Each provider maps its models onto the tiers; Sift ships a tested mapping for each supported provider.

**Tiers:**

- **Frontier** — a vendor's strongest generally available model.
- **Mid** — a vendor's balanced model: strong, faster, and cheaper than frontier.
- **Small** — a vendor's fastest, cheapest model.
- **Local** — open-weight models run on the user's own hardware. Capability varies widely by model size, so a local model is assigned to a tier only by qualification (8.4).

**Recommended tier per task:**

| Task | Recommended tier | Minimum tier | Reason |
|---|---|---|---|
| Describe a full unit | Frontier | Mid | Accuracy, complete coverage, and correct nesting matter most; this is the core of the product. |
| Describe a lite unit | Small | Small | One- or two-sentence summaries of simple helpers; high volume, low difficulty. |
| Update a changed unit | Frontier | Mid | Making only the minimum edit and keeping unchanged wording is harder than describing from scratch. |
| Re-check after callee summaries change | Small | Small | Mostly a "no change needed" decision. |
| Evaluation judge | Frontier | Frontier | Low volume; judgement quality determines whether every other measurement can be trusted. |
| Code change from a natural-language edit (Phase 2) | Frontier | Frontier | Generated code must be correct; cost per edit is small relative to the cost of a wrong change. |

When a task runs below its minimum tier, Sift warns the user and marks the output so it is clear that it came from a model below the recommended capability.

**Default mapping for the first provider (Claude Code CLI):**

| Tier | Model | Default effort |
|---|---|---|
| Frontier | Claude Opus 5.5 | medium for describing and updating; high for judging and code changes |
| Mid | Claude Sonnet 5.5 | medium |
| Small | Claude Haiku 5.5 | low |

Mappings for other providers are added with each provider, based on evaluation results. A cheaper model or tier replaces a recommended one only when the evaluation shows it meets the same quality bar for that task.

**Judge independence:** a model tends to rate output in its own style more favourably. When the judge and the model being graded are the same, results are flagged as self-graded and rely more heavily on the deterministic checks and human spot checks. Once a second provider is available, the judge is taken from a different vendor than the model under test.

### 8.3 Prompt Portability

Prompts must work across models, not only the model they were tuned on. Smaller models, newer models, and models from other vendors (once additional providers exist) behave differently with the same prompt. Prompt design rules:

- **Validate, don't trust.** Output format and completeness are enforced by schema validation and the deterministic checks (coverage, effects, input names), with a retry that names the specific failures. Correctness never depends on a model following an instruction perfectly.
- **No model-specific tricks.** Prompts do not rely on behaviors particular to one model or vendor (such as pre-filling the start of the answer, or vendor-specific markup conventions).
- **Self-contained and explicit.** Every fact the model needs (types, callee summaries, detected effects, the structure keys) is in the prompt. Short worked examples are included, since they help smaller models most.
- **Concise.** Overly prescriptive prompts written for older or weaker models tend to lower the quality of stronger models. Instructions state what is needed and why, without excessive repetition or emphasis.
- **Separated concerns.** The prompt content is provider-neutral; only formatting and transport are provider-specific.
- **Versioned.** Prompts are versioned files, and evaluation results record which prompt version and model produced them.

When a prompt changes, the review considers how each model tier and vendor is likely to respond to it, and the evaluation is run across the model matrix (12.3) before the change is adopted.

### 8.4 Bring Your Own Key

Users can bring a key for any supported provider. Models differ in ways that affect Sift beyond raw quality:

- **Structured output.** Some providers can enforce a JSON schema on the response; others cannot. Providers use native schema enforcement when available; otherwise Sift relies on instructions plus validation and retry. Models that cannot reliably produce valid JSON after a retry are not supported for that task.
- **Context window.** Smaller and local models have less room. When a prompt does not fit, context is reduced in a fixed priority order (the unit's own code and structure are never cut; full type definitions are cut before callee summaries), and the reduction is recorded.
- **Instruction following.** Weaker models are more likely to skip nested code, merge steps, invent calls, or ignore the output format. The deterministic checks catch these; if a model fails them repeatedly, a simpler fallback is used that splits one request into smaller ones (for example, steps first, warnings separately).
- **Cost and limits.** Pricing, rate limits, and token counting differ by vendor. Usage and estimated cost are reported per provider and model.
- **Privacy.** With a cloud provider, the code in each prompt is sent to that vendor. Local models keep code on the user's machine, and Sift states clearly which applies.

**Qualification:** before a user's model is used for a task, Sift can run a short qualification — a subset of the evaluation set — and report whether the model meets the minimum bar for each task. Unqualified models can still be used, but with a warning.

**Provenance:** each unit records which provider and model produced its description, so readers can tell whether a description came from a model below the recommended tier.

**Consistent wording across a team:** if teammates use different models, regenerated descriptions could change wording back and forth. The project's model routing is stored in the committed project configuration, so a team shares the same models by default. Incremental regeneration already preserves the wording of steps whose code did not change, which limits churn when models do differ.

### 8.5 Context for Generation

To describe a unit well, the AI receives:

- The unit's source code.
- Signatures and summaries of the units it calls.
- Relevant type definitions.
- The deterministic layer for the unit (effects, calls, structure).
- Existing comments and docstrings.
- The previous description, when updating.

If existing comments or docstrings contradict the code, the system raises a warning rather than repeating the comment as fact.

### 8.6 Scoped Assistance

AI assistance is available at multiple levels: an individual step, a unit, a file, a related group of units, and the whole project. Users can ask questions, request modifications, and investigate failures without losing the connection to the relevant `.sift` files and source.

### 8.7 Targeted Editing

AI prefers minimal, scoped changes. It has access to the current source, the current and previous `.sift` content, imports and type definitions, callers and callees, related data models, tests, project conventions, and relevant diagnostics.

### 8.8 Review and Approval

The product supports:

- Source-code diffs.
- Natural-language summaries of proposed changes.
- Affected-unit and dependency summaries.
- Test and type-check results.
- Approval and rejection of proposed changes.
- Undo and rollback.

Configurable autonomy may come later; potentially breaking or security-sensitive changes always receive careful review.

### 8.9 Transparency

The AI must distinguish between:

- What the current source code does.
- What the `.sift` file says the code does.
- What the user requested.
- What the AI believes should change.
- What has actually been verified.

The product never claims code is correct, secure, or behaviorally equivalent solely because it was generated or successfully parsed.

---

## 9. Delivery and Platform

### 9.1 Delivery Sequence

1. **Command-line tool** — the derivation engine: generating `.sift` files, reporting status, checking for drift, and querying the code graph. This is where description quality is developed and measured.
2. **MCP server** — exposes descriptions, the code graph, and impact analysis to AI coding agents (for example, Claude Code or Cursor), so agents can use Sift's understanding of the codebase directly.
3. **VS Code extension** — the logic document, step navigation, natural-language editing, and review, built on top of the same engine. This is the current end goal. Because the same extension can run in VS Code-based editors such as Cursor and Windsurf, it reaches the initial audience inside the tools they already use.
4. **Standalone IDE (Code-OSS fork)** — a reach goal, pursued only if the extension runs into concrete limits that block the product (for example, making the logic document the default view of a source file with deep editor integration, or a fully custom layout and onboarding for non-technical users). Limits encountered while building the extension are recorded as the case for or against a fork.

### 9.2 Standalone IDE

A future standalone IDE would include:

- Custom name, branding, icons, and onboarding.
- Integrated logic document editor.
- Project and file navigation.
- Source-code editor.
- Integrated terminal and test runner.
- AI assistant.
- Git integration.
- Language tooling and diagnostics.

A fork introduces ongoing work to merge upstream changes, maintain custom editor functionality, package builds, keep extension compatibility, and handle platform differences. Custom functionality should be isolated to reduce merge conflicts.

### 9.3 Language Tooling

The product reuses existing compilers, language servers, and parsers (TypeScript compiler, Tree-sitter, Pyright, gopls, and others) rather than recreating them.

### 9.4 Implementation Technology

The engine and command-line tool are written in TypeScript on Node.js. This gives direct access to the TypeScript compiler API for the first adapter and allows the engine to be reused inside a VS Code extension.

### 9.5 Distribution

Target platforms are macOS, Windows, and Linux. Signed installers and automated release workflows are future requirements and should not distract from validating the core product.

---

## 10. Non-Functional Requirements

### 10.1 Reliability

- `.sift` files must not silently drift from source code.
- Failed generation or edits must not corrupt existing source code or `.sift` files. Writes are atomic.
- Changes must be recoverable.
- Stale and ambiguous mappings must be detected.
- The product must communicate when a representation has not been verified against current source.

### 10.2 Performance

- Existing descriptions load without any AI call.
- Parsing and hashing do not block the editor interface.
- AI work is limited to changed or requested units.
- Large projects support incremental indexing.

Specific targets will be set after measuring a working prototype.

### 10.3 Cost Efficiency

- No AI calls for unchanged units.
- Smaller, faster models for suitable tasks; stronger models where necessary.
- Context limited to relevant units, types, dependencies, and tests.
- AI usage and cost are visible to users.

### 10.4 Privacy and Security

- Secrets (API keys, `.env` contents, credentials) are never sent to AI providers. Content is filtered for secrets before any AI call, and files such as `.env` are excluded entirely.
- Users control what project content is sent to AI providers.
- AI-generated code is treated as untrusted until validated.
- Generated code is not executed without appropriate safeguards.
- Security-sensitive operations are always visible in the logical representation.

### 10.5 Maintainability

- Modular architecture with the core separated from language adapters and from any user interface.
- Versioned `.sift` schema with migrations.
- Incremental language additions through adapters.
- Reuse of established parsing, compiler, testing, and language-server infrastructure.

### 10.6 Language

Descriptions are generated in English. Other languages may be supported later.

---

## 11. Risks and Concerns

These are fundamental product risks, not details to defer indefinitely.

### 11.1 Natural-Language Ambiguity

**Concern:** Natural-language descriptions and edits can be interpreted in multiple ways. "Update the user's account" does not specify transaction boundaries, authorization, failure behavior, concurrency, or which fields may change.

**Mitigation:**
- Preserve explicit behavior and execution order.
- Ask clarifying questions when required details are missing. When a question is answered, implement the answer in code and add it explicitly to the description (for example, the description is updated to mention the transaction the user confirmed).
- Represent important operations and types in deterministic metadata.
- Distinguish user-specified behavior from AI-proposed behavior.
- Validate generated implementation against the requested logic.

The goal is not to force users to specify every line of code, but to make meaningful behavior explicit enough to implement safely.

### 11.2 Incorrect or Misleading Descriptions

**Concern:** An AI-generated description may omit behavior, misunderstand the implementation, or become outdated.

**Mitigation:**
- Check AI-generated content against the deterministic layer (coverage rule, effects, calls, throws).
- Track hashes and mark stale descriptions.
- Mark generated descriptions as unverified until verified.
- Measure description quality against an evaluation set.

### 11.3 Synchronization

**Concern:** Source code changes constantly — from developers, AI agents, and Git operations — and descriptions can fall behind.

**Mitigation:**
- Source-first model: the code is authoritative, so synchronization is derivation rather than two-way merging.
- Stable identifiers and incremental regeneration.
- Drift checks in CI and hooks.
- Early testing of branch switches, merges, rebases, external edits, and AI-agent changes.

### 11.4 Description Churn

**Concern:** Regenerating prose with an AI rewords unchanged content, producing noisy diffs and eroding trust.

**Mitigation:** Incremental regeneration that preserves unchanged steps, formatting-preserving serialization, and churn measured as part of evaluation.

### 11.5 Targeted Changes with Broad Effects

**Concern:** A small edit can affect callers, shared types, database schemas, serialization, or other parts of the application.

**Mitigation:** Use the code graph to identify affected callers, types, endpoints, and tests; show the scope of changes; validate broadly where appropriate; and require approval for changes beyond the requested scope.

### 11.6 Natural Language Does Not Remove Complexity

**Concern:** Hiding syntax does not remove concurrency, transactions, authorization, data modeling, asynchronous behavior, or distributed systems.

**Mitigation:** Explain concepts accessibly, surface important details and trade-offs, avoid vague summaries, and keep the code and technical metadata inspectable.

### 11.7 Language-Agnostic Translation

**Concern:** Languages differ in type systems, runtime semantics, libraries, concurrency, and error handling.

**Mitigation:** Language adapters with deep, language-specific understanding; framework rule packs; explicit identification of unsupported constructs; no claims of universal compatibility; languages added incrementally.

### 11.8 Testing Cannot Prove Correctness

**Concern:** Passing tests and type checks do not prove code is correct or secure.

**Mitigation:** Show exactly which checks ran; distinguish passed, failed, skipped, and unavailable checks; encourage coverage; use static analysis and security tooling; never equate validation with guaranteed correctness.

### 11.9 Non-Technical User Expectations

**Concern:** Non-technical users may expect to build and maintain complex applications without understanding the concepts involved.

**Mitigation:** Introduce concepts progressively, explain decisions and consequences, ask for clarification, make limitations visible, and validate whether non-technical users can actually use the representations.

### 11.10 Existing Competition

**Concern:** AI coding tools already offer code explanation, codebase understanding, generation, and automated fixes.

**Mitigation:** Differentiate on persistent, editable, verified, synchronized logic representations — not on chat or explanation. Demonstrate measurable improvements in review, comprehension, and modification.

### 11.11 Code-OSS Fork Maintenance

**Concern:** A standalone fork brings ongoing upstream merge, packaging, extension, and compatibility work.

**Mitigation:** Prove the product as a command-line tool and VS Code extension first; fork only when deeper customization is required; isolate custom functionality.

### 11.12 Product Scope and Audience

**Concern:** Serving non-technical builders, AI-assisted developers, and experienced developers at once could produce a product too complex for newcomers and too shallow for experts.

**Mitigation:** Start with developers who use AI coding agents, validate audiences separately, and build the core so it can support broader audiences later.

---

## 12. Evaluation

Description quality is improved by iterating on prompts and the pipeline, so it must be measured.

### 12.1 Evaluation Set

A sample TypeScript application (a small banking system with services, repositories, transfers, and tests) serves as the first evaluation set. It deliberately includes known problems and tricky cases, such as:

- Balance updates without a database transaction.
- A missing balance check.
- An interface with more than one implementation.
- Inline callbacks, small helpers, recursion, and async error handling.
- Comments that contradict the code.

Real-world code from other projects is added over time.

### 12.2 Metrics

- **Coverage:** percentage of units that pass the coverage rule.
- **Missed effects:** detected side effects, calls, or throws not mentioned in any step.
- **Accuracy:** descriptions judged correct (AI judge, with human spot checks).
- **Warning recall:** planted problems that produced a warning.
- **Churn:** content changed by regeneration when the code did not change, or changed only slightly.
- **Cost and latency:** AI usage and time per unit.
- **Variance:** how much results differ between repeated runs of the same prompt and model.

### 12.3 Cross-Model Evaluation

Every prompt is evaluated against a matrix of models, not only its recommended model:

- At minimum, the recommended tier and the next cheaper tier for each task (8.2).
- For every supported provider, the models mapped to those tiers, so each provider's default mapping is backed by results.
- At least one capable local model, since local models are the most likely to fall short and the most important for privacy-sensitive users.
- Each combination is run more than once to measure variance.

Supported providers and their tier mappings are published together with these results, so users bringing their own key can see how their model performed before using it.

Results are compared per task, and the routing is set to the cheapest model that meets the quality bar for that task. A prompt change that improves one model but noticeably degrades another is not adopted without a deliberate decision. Results also record where each model fails (for example, skipped steps, invented calls, or ignored instructions), so the prompts and deterministic checks can be strengthened where models are weakest.

---

## 13. Roadmap

Schedules are estimates; the representation and correctness requirements must be validated before reliable estimates can be made.

### Phase 1 — Derivation Engine (command line)

- Core, `.sift` schema v0, and serialization.
- TypeScript/JavaScript adapter.
- Built-in framework rule packs: Prisma, Node `fs`, `fetch`, Express routes.
- Code graph with edge confidence, built incrementally into the cache.
- AI provider interface with the Claude Code CLI provider.
- Generation pipeline: deterministic extraction, dependency-ordered AI description, coverage validation.
- Staleness detection, incremental regeneration, and caching.
- Commands to generate, report status, check for drift, and query callers, callees, and impact.
- Evaluation set and harness.

Success criteria:
- Generated descriptions let a developer understand a function more quickly than reading the code.
- Descriptions pass the coverage rule and miss no detected effects across the evaluation set.
- Regeneration of unchanged code produces no changes.
- Drift is detected reliably after source edits and Git operations.

### Phase 2 — MCP Server, VS Code Extension, and Natural-Language Editing

- MCP server exposing descriptions, the graph, and impact analysis to AI coding agents.
- Logic document view and source side-by-side.
- Focused graph views: a unit's neighbourhood, flows from endpoints, impact of a change.
- Step navigation (Ctrl+click) and implementation picker.
- Natural-language edits as change requests: targeted changes, diffs, validation, approval, undo.
- Clarifying questions and warnings during editing.
- Identification of affected callers, types, and dependencies.

### Phase 3 — Testing and Debugging Integration

- Associate tests with units.
- Test runner integration.
- Map failures and diagnostics to steps.
- AI-assisted investigation and fixes.
- Accurate validation status.

### Phase 4 — Broader Language and IDE Support

- Python adapter; publication of the adapter plugin API.
- Generic Tree-sitter + language server adapter.
- Project-wide logical map with concept groupings.
- Improved Git and merge workflows.
- Packaging and distribution of the extension.
- Standalone Code-OSS fork (reach goal; only if the extension's limits require it).
- Onboarding for non-technical users.

---

## 14. Success Metrics

- Time to understand an unfamiliar function or feature.
- Time to review AI-generated changes.
- Percentage of descriptions users consider accurate.
- Percentage of natural-language edits that produce correct, targeted changes.
- Frequency of unrelated code changes during targeted edits.
- Rate of successful re-derivation after external source edits.
- Percentage of test failures mapped to relevant steps.
- User trust and willingness to use the logic representation as a primary review interface.
- Adoption and retention among the initial audience.

Metrics are measured against existing workflows, not treated as success merely because a feature works technically.

---

## 15. Open Questions

### 15.1 Natural-Language Editing

- How much freedom should users have to write unrestricted English?
- When should the system ask clarifying questions versus proceed?
- How should ambiguity or unsupported behavior be shown in the editor?

### 15.2 `.sift` Format

- How should schema migrations be delivered and run?
- How should test references be discovered and stored?

### 15.3 Presentation and Review

- Is the logic document the right primary presentation, or are cards or other layouts better for some workflows?
- How should a natural-language diff be displayed?
- How should source diffs and logic diffs be connected?
- When should changes be applied automatically versus awaiting approval?

### 15.4 Project-Level Representation

- Is a whole-project map with AI-proposed concept groupings valuable enough to build, and how are groupings kept current as code changes?
- How can architecture be summarized without hiding implementation details?

### 15.5 AI and Models

- What controls do users need over what content is sent to providers, beyond secret filtering and file exclusion?

### 15.6 Audience

- What evidence is needed before expanding to non-technical builders?
- Which workflows are valuable enough that developers would add Sift to their current tools?

---

## 16. Central Product Thesis

Software should be understandable and editable at the level of its logical behavior, without requiring every user to work directly in the syntax of the programming language that implements it.

The product succeeds only if this abstraction remains accurate, traceable, and trustworthy — not merely readable.
