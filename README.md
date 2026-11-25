# Sift

Readable, verified descriptions of what your code does, kept in sync with the code.

Sift reads your source code and writes a plain-language description of every function, method, and component: what it does, step by step, what it calls, which side effects it has (database, network, files), and what looks wrong. The descriptions live in `.sift` files next to your code, and Sift keeps them in sync as the code changes. The code stays the source of truth: anything Sift can work out from the code (calls, effects, hashes) is computed, never guessed, and the AI only writes the prose.

- [Requirements](requirements.md)
- [Phase 1 design](docs/design.md)

> Sift is in early development (Phase 2: the command-line tool, an MCP server for AI agents, and a VS Code extension). It supports TypeScript and JavaScript.

## What you need

- **Node.js 20.12 or later.**
- **Claude Code**, installed and logged in. Sift writes descriptions by running `claude -p` on your own Claude subscription; no API key is needed. Run `claude` once in a terminal and use `/login` if you haven't. (Logging in to the Claude desktop app does not log in the `claude` command.)
- **git**, for `sift impact --diff`.

## Install

Sift is not published to npm yet. Install it from this repository:

```sh
git clone <this repository> sift
cd sift
npm install
npm run build
cd packages/cli
npm link                      # puts the `sift` command on your PATH
```

Check it works with `sift --help`. To run it without linking, use `node <path to sift>/packages/cli/dist/main.js` instead of `sift`.

## Quick start

In the root of your project:

```sh
sift init                     # creates sift.config.yaml and .sift/, updates .gitignore
```

Open `sift.config.yaml` and check `include` and `exclude`: they decide which files get described (by default `src/**`, without tests and build output). Then:

```sh
sift generate --dry-run       # what would be described, by which model; no AI calls
sift generate                 # describe everything
```

The first run takes about two seconds per function overall (four run at a time) and prints a summary with token use and an estimated cost. Then read the result:

```sh
sift show src/accounts/account-service.ts
sift show "src/accounts/account-service.ts#AccountService.withdraw"
```

```text
AccountService.withdraw  · method · generated, not verified
  Withdraws an amount from an account owned by the given user by lowering its balance, saves the
  account, and returns it.
  Inputs
    userId (string): ID of the user asking to withdraw; must be the account's owner.
    ...
  Effects: db.write, throws
  Steps
    1. Get the account from the repository; this fails with a "not found" error if there is none.
       → src/accounts/prisma-account-repository.ts#PrismaAccountRepository.getAccount
    2. If the account is not owned by the user,
       2.1. stop with a "forbidden" error saying users can only withdraw from their own accounts.
    3. Subtract the amount from the account's balance.
    ...
  Warnings
    ! missing-check (step 3): The balance is never checked against the amount, so a withdrawal can
      make the balance negative.
```

Commit `sift.config.yaml` and the `.sift/` folder with your code, so everyone on the project shares the descriptions. (`.sift/.cache/` and `.sift/models.local.yaml` are personal and are ignored by git.)

## Keeping descriptions in sync

After you change code, run:

```sh
sift status                   # what is out of date; no AI calls
sift generate                 # bring the descriptions up to date
```

`generate` only does what is needed:

- **New** functions are described.
- **Changed** functions are updated: the AI gets the previous description and a diff of the code, and keeps the wording of every step whose code didn't change.
- **Renamed or moved** functions and files keep their IDs, so references to them stay valid.
- **Deleted** functions are removed.
- **Callers** of a function whose summary changed get a quick check (on a small model) of whether their own wording is still right.
- Everything else costs nothing: calls and effects are recomputed from the code without the AI.

Use `sift generate src/payments` to limit a run to some files or folders, and `--force` to describe everything again from scratch (IDs are kept).

### In CI or a pre-commit hook

`sift check` prints the same report as `status` and exits with code 1 when any description is out of date:

```sh
sift check                    # exit 0: in sync; exit 1: run `sift generate`
```

In CI (when the `CI` environment variable is set) it hashes every file instead of trusting file timestamps.

## Exploring the code

These commands use the code graph Sift builds from your code; they make no AI calls and work before any descriptions exist.

```sh
sift callers transferFunds              # who calls it (-d 3 for three levels up)
sift callees AccountService.transferFunds   # what it calls, with effects
sift impact PrismaAccountRepository.getAccount   # units and HTTP routes affected by a change
sift impact --diff main                 # everything affected by your branch's changes
sift flow "POST /transfers"             # what a route does: handler, units, library calls, effects
sift show --structure src/app.ts        # what the language adapter extracted
```

Symbols can be given as `file#Symbol`, `Class.method`, or just a unique name. Calls through interfaces, Express routes, and event buses are followed; calls Sift cannot resolve are listed as such rather than guessed. Every query command takes `--json`.

## The `.sift` files

Each source file `src/x.ts` gets `.sift/src/x.ts.sift`, a YAML file with one entry per function. Each entry has a stable ID, a summary, input and return meanings, the steps (each with the code it covers, the units it calls, and its effects), and warnings. A status says where it came from:

| Status | Meaning |
|---|---|
| `generated` | Written by the AI, not yet checked by a person. |
| `user-edited` | A person edited the wording. Sync keeps that wording; if the AI would change it, the unit is marked `stale` for review instead. |
| `verified` | A person checked it. Any AI change returns it to `generated`. |
| `stale` | Incomplete, or waiting for review. `sift status` lists these. |

Wording a person wrote can also be marked piece by piece: a step gets `status: user-edited`, and the summary, returns, or an input meaning are listed under the unit's `userEdited` (for example `userEdited: [summary, inputs.amount]`). Sync then protects only those pieces; the rest of the unit is updated as usual.

Once you have read a description and agree with it, mark it checked:

```sh
sift verify AccountService.transferFunds    # one unit
sift verify src/accounts/account-service.ts # every unit in a file
```

Only descriptions that match the current code can be verified; `verify` says why it refused the others.

You can edit summaries and step texts by hand and mark them as yours. Don't edit `calls`, `effects`, `covers`, or the hashes: Sift derives them from the code.

**Schema versions.** `.sift` files written by Sift 0.1 are schema 0. A file moves to schema 1 only when it gets a schema 1 field (step `status`, `userEdited`, or a resolved warning), so upgrading Sift does not touch your files. `sift migrate` upgrades them all at once if you prefer one commit. Older versions of Sift refuse schema 1 files rather than misread them.

## Changing code through its description

Edit what a function should do, in its description or in your own words, and Sift proposes the code change for you to review. Nothing is written until you approve it.

```bash
sift edit AccountService.withdraw --request "Reject amounts of zero or less"
sift edit AccountService.transferFunds --step s_b2v7 --text "Save both accounts inside one database transaction."
```

Sift plans the change (and asks if the request leaves something important open: what happens on failure, transaction boundaries, who may do it), writes the code for that unit only, checks that it parses, type-checks, and changes nothing outside the request, describes the new code, and compares that with what you asked. It prints the plan, the logic diff, the code diff, the scope (what else may be affected, and which routes reach it), and the checks. Then:

```bash
sift edit apply e_ab12cd34       # write the code and the description; --apply on the first command does the same
sift edit undo e_ab12cd34        # restore both, only if nothing changed them since
sift edit list                   # open change requests
```

- Questions are asked on the terminal, or answered ahead of time (`--answer q1="Stop with an error"`) or later (`sift edit answer <id> q1=…`).
- A rewording that doesn't change behaviour is kept only if it is still accurate for the code; no code is generated.
- A change that reaches other units (callers of a changed signature, other implementations) is shown as a broader change and needs `--confirm-broader`.
- If the code changes before you apply, the request is marked for review and is never applied to code it wasn't written against (`sift edit replan <id>` starts it over).
- `sift edit checks <id>` runs the commands in `edit.checks` (below) against a temporary copy of the project with the change. Generated code is never run unless you ask.

Change requests are kept in `.sift/edits/` (git-ignored). Planning and code generation use the frontier tier (Opus 5.5); describing the new code and the intent check use the mid tier.

## AI coding agents (MCP)

`sift mcp` gives an AI coding agent the same answers as the commands above, as MCP tools: what a function does, who calls it, what a change affects, and what a route reaches. To add it to Claude Code, run this in your project's root (after `npm link`, so `sift` is on your PATH):

```sh
claude mcp add sift -- sift mcp
```

For another MCP client, configure the command `sift mcp --root <your project>` on stdio.

| Tool | What it answers |
|---|---|
| `sift_describe` | What a unit or whole file does: summary, inputs, returns, steps with their calls, effects, warnings, and status. |
| `sift_find` | Units whose name matches, with a one-line summary. |
| `sift_callers` / `sift_callees` | Who calls a symbol, and what it calls, with effects and confidence. |
| `sift_impact` | Units and routes a change to some symbols may affect, or `{ diff: "HEAD" }` for everything changed since a git ref. |
| `sift_flow` | What a route does, down to the library calls; without a route, the list of routes. |
| `sift_status` | Which descriptions no longer match the code. |

Every tool only reads; none changes your code. Results reflect the files on disk, including the agent's own saved edits. A description that may not match the code starts with "Stale:", so the agent never takes an outdated description as current. Lists stop at 50 items and say what they left out. Each described file is also available as the resource `sift://file/<path>`.

`sift mcp --allow-generate` adds `sift_generate`, which writes descriptions for new and changed code. It is off by default because it spends your AI quota.

## Editors

### VS Code

The extension in `packages/vscode` is not on the marketplace yet. Build it and install the `.vsix`:

```sh
npm run package:vscode
code --install-extension packages/vscode/sift.vsix
```

It starts Sift for each workspace folder with a `sift.config.yaml` (no `sift` on your PATH needed: the engine is bundled) and shows:

- the **logic document** of a source file: **Sift: Open Logic** (`Ctrl+Alt+L`, or the book button in the editor title) opens it beside the code, and `.sift` files open as logic documents. Each function is a section with a status badge (Unverified, Edited, Verified, Stale), its summary, inputs and returns, effects, steps, and warnings. Hovering a step highlights its code; moving the cursor in the code marks the step that owns it. Ctrl+click (or F12) on a step follows its call to the callee's logic, with a picker when an interface has several implementations; Alt+click opens the callee's code; hovering the `→` on a step shows where its calls go, including library calls and their effects. **Verify** marks a description as checked by you;
- the number of out-of-date or missing descriptions in the status bar, and a dot in the explorer on files whose logic is out of date or not described yet;
- an **Out of Date** list in the Sift sidebar, grouped by reason;
- **Callers** and **Callees** of the function at the cursor (editor context menu), with how each call was resolved and the calls Sift could not resolve;
- **diagrams**: **Show Neighbourhood Diagram** (the function at the cursor with its callers, callees, interface implementations, routes, and events), **Show Route Flow…** (a route from its handler down to library calls, effects on each box), and **Show Impact of Changing This** / **Show Impact of Uncommitted Changes** (what may be affected, grouped by distance, with a diagram on request). Click a box to open its logic, Alt+click for its code, Shift+click for its neighbourhood; dashed lines are connections from a rule pack or a name match, and unresolved calls are listed rather than hidden;
- **Sift: Describe This File** (editor title button), **Describe Folder** (explorer), and **Update Out-of-Date Descriptions**. Each first shows what will be sent to which models and asks; a running update can be cancelled, and the units already described are kept;
- **editing**: **Edit** on a function in its logic document (or **Sift: Edit Logic of This…** in the code) lets you rewrite its summary, input and return meanings, and steps in place, add and remove steps, or write what to change in your own words. The draft is kept until you **Propose change**; Sift then plans it (asking its questions in the document when the request leaves something open), writes and checks the code, and opens a **review**: what it understood, the logic changes word by word, the code diff (also in VS Code's diff editor), what else may be affected, which checks ran, and anything it did not do or was not asked for. **Approve and apply** writes the code through the editor (so Undo works there too) and the description; **Sift: Undo Edit…** restores both if nothing changed them since. A draft whose code changes before you apply it is marked for review and can be re-planned on the current code.

`sift.updateOnSave: ask` offers an update after you save a file whose logic is now out of date. Sift never calls the AI without asking.

### Other editors

`sift serve` runs Sift's engine as a JSON-RPC server on stdin and stdout; the protocol is defined in `packages/server/src/protocol.ts`.

## Configuration

`sift.config.yaml`:

```yaml
include: ["src/**"]
exclude: ["**/*.test.*", "**/dist/**"]
provider: claude-code
concurrency: 4                # AI calls at once
lite:
  maxStatements: 3            # small, branch-free functions get a one-line summary only
models:                       # optional; shared by the team
  tasks:
    describe: mid             # run a task on another tier
  tiers:
    small: { model: claude-haiku-5-5, effort: low }   # use another model for a tier
edit:                         # optional; for sift edit
  checks:                     # run on request against a copy of the project with a proposed change
    - npm run lint
    - { name: tests, command: npx vitest related src --run }
  checkTimeoutSeconds: 300
```

**Models.** Each task runs on a tier, and each tier maps to a model: describing and updating on the mid tier (Sonnet 5.5), small functions and caller checks on the small tier (Haiku 5.5). `sift models` shows the current routing and where each choice came from. Personal overrides go in `.sift/models.local.yaml` with the same `tasks` / `tiers` shape. If a model isn't available on your plan, Sift falls back to the next tier and says so.

**Rule packs** teach Sift which library calls have effects and how frameworks connect code. Built-in packs cover Prisma, Node's `fs` and `child_process`, `fetch`, `console`, and Express ([list](packages/rules/packs/README.md)). Add your own in `.sift/rules/*.yaml`, for example for your own event bus:

```yaml
pack: my-events
version: 1
edges:
  - match: { symbol: "EventBus.emit" }
    edge: emits
    key: { arg: 0 }
  - match: { symbol: "EventBus.on" }
    edge: listens
    key: { arg: 0 }
    from: { arg: 1 }
```

## Privacy and cost

- Sift sends each function's code, with the signatures and summaries of what it calls, to Anthropic through Claude Code, on your own login. Nothing else in the project is sent, and Claude Code runs with no tools, no project settings, and no MCP servers.
- `sift edit` also sends the code of the units it may change, their files' imports, the project types they use, and up to three similar functions from the project as examples.
- Values that look like secrets (API keys, tokens, private keys, high-entropy strings) are replaced with `<redacted>` before anything is sent; the run summary says how many. `sift edit` refuses to rewrite a unit that contains one, since the model could not write it back.
- Costs are shown at API prices for comparison. On a subscription they are not billed; your plan's usage limits apply instead. Describing a 30-function project costs about $0.60 at API prices; keeping it in sync costs a few cents per change.

## Troubleshooting

| Message | What to do |
|---|---|
| `Claude Code is not logged in` / `OAuth session expired` | Run `claude` in a terminal, use `/login`, then run Sift again. |
| `No sift.config.yaml found` | Run `sift init` in the project root, or pass `-C <project root>`. |
| A unit `failed` | It keeps its previous description; the summary shows why. Run `sift generate` again. |
| A call shows as `not resolved` | The code didn't type-check at that call, or it is dynamic. Fix the types, or add a rule pack. |
| `claude` is not on your PATH | Set `SIFT_CLAUDE_COMMAND` to the full path of the `claude` executable. |

## Development

Requires Node.js 20.12 or later.

```sh
npm install
npm run verify      # build (packages and the extension bundle), type-check (including tests), run tests
npm run sift -- --help
npm run test:vscode # extension integration tests in a downloaded VS Code (opens a window; run `npm run build` first)
npm run package:vscode
```

| Package | Purpose |
|---|---|
| `packages/core` | Language- and provider-independent engine: config, schema, sync pipeline, graph, prompts, and the `Workspace` every front end uses |
| `packages/adapter-typescript` | TypeScript/JavaScript language adapter |
| `packages/provider-claude-code` | AI provider using `claude -p` |
| `packages/rules` | Built-in framework rule packs |
| `packages/server` | `sift serve`: the workspace over JSON-RPC, with a typed client for editors |
| `packages/mcp-server` | `sift mcp`: descriptions and the code graph as MCP tools for AI coding agents |
| `packages/vscode` | The VS Code extension: bundles the engine and runs `sift serve` per workspace folder |
| `packages/cli` | The `sift` command |
| `eval/harness` | Evaluation harness behind `sift eval` |

### Evaluating prompt and model changes

`sift eval` runs Sift on the fixture in `eval/fixtures/bank-app` (a small app with planted problems) and scores the result against `eval/expectations/bank-app.yaml`: coverage, missed effects, expected warnings, accuracy and expected ideas (scored by an AI judge), churn after small edits, cost, and latency.

```sh
sift eval                         # recommended routing, one run
sift eval --tier describe=mid     # one task on another tier
sift eval --matrix                # every configuration in eval/matrix.yaml, 3 runs each
sift eval --no-judge              # deterministic metrics only
```

Each run writes `eval/results/<timestamp>.json` and a Markdown report with the summary table and every finding. The fixture itself is never changed. Change a prompt (`packages/core/prompts/*.md`, and bump its `version`) only if no configuration in the matrix gets noticeably worse.
