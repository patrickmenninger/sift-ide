# Changelog

All notable changes to Sift are recorded here. Versions follow the roadmap phases in [requirements.md](requirements.md): each phase ends with a minor release on `main`.

## Unreleased — Phase 2

### Added

- **Workspace** (`@sift/core`): one long-lived engine behind the CLI and editors, with logic files and their freshness, step ↔ source ranges, the step at a source position, navigation targets for a step's calls, and change notifications.
- **`sift flow <route>`**: what an HTTP route does, from its handler down to the library calls, with effects. A route registered as an inline callback is followed only through that callback.
- **`sift verify`**: mark units or whole files as checked by a person; descriptions that don't match the current code are refused.
- **`.sift` schema 1**: step-level `status` (`user-edited`, `verified`), a unit's `userEdited` fields, and `resolved` warnings. Sync protects exactly the wording a person wrote. Files stay at schema 0 until they need a schema 1 field; `sift migrate` upgrades them all at once.
- **`sift serve`** and `@sift/server`: the workspace over JSON-RPC on stdio, with a typed client, for the VS Code extension.

### Changed

- Every CLI command runs through the workspace.

## 0.1.0 — Phase 1: Derivation Engine

First release: a command-line tool that reads a TypeScript/JavaScript project and keeps `.sift` files — natural-language descriptions of every function — in sync with the code. Design: [docs/design.md](docs/design.md).

### Added

- **Monorepo and CLI** (`sift`): `init`, `generate`, `status`, `check`, `show`, `callers`, `callees`, `impact`, `models`, `eval`; `sift.config.yaml` with include/exclude, concurrency, lite-unit thresholds, and model routing overrides.
- **TypeScript/JavaScript adapter** on the TypeScript 6.0 compiler API: units, structure trees with stable keys, input and return types (inferred types marked), normalized hashes, call resolution, interface implementations, and external calls.
- **`.sift` schema v0**: strict validation with located errors, byte-stable YAML serialization (unchanged units keep their exact text), atomic writes, and a disposable cache for extractions, fingerprints, the graph, and unit sources.
- **Framework rule packs**: Prisma, Node `fs`, `child_process`, `fetch`, `console`, and Express routes; project packs in `.sift/rules/`; effect propagation and edge rules for routes and events.
- **Code graph** with edge confidence and gaps, an incremental refresh with a freshness fast path, and `callers` / `callees` / `impact` (including `impact --diff <ref>`).
- **AI generation** through the Claude Code CLI provider: describe and describe-lite prompts, validation with one retry, coverage checks, callee-first ordering, model routing by tier with fallback, provenance, and secret redaction.
- **Sync**: identity matching (renames, moved units, moved files), incremental update prompts that keep unchanged wording, context checks when callee summaries change, and `status` / `check` for CI and hooks.
- **Evaluation harness** on the bank-app fixture: coverage, missed effects, expectations, an AI judge, churn after scripted edits, cost and latency, and a model matrix.
- **Lower token use**: units in the same file are described in one call (`batch.maxUnits`, default 8), and describe/update run on the mid tier by default.

Bank-app baseline (describe and update on Claude Sonnet 5.5): coverage 100%, 0 missed effects, expectations 98%, 86% judged accurate and 100% acceptable, about $0.007 per unit at API prices.
