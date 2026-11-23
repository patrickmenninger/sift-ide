# Sift

Readable, verified descriptions of what your code does, kept in sync with the code.

Sift reads your source code and writes a plain-language description of every function, method, and component: what it does, step by step, what it calls, which side effects it has (database, network, files), and what looks wrong. The descriptions live in `.sift` files next to your code, and Sift keeps them in sync as the code changes. The code stays the source of truth: anything Sift can work out from the code (calls, effects, hashes) is computed, never guessed, and the AI only writes the prose.

- [Requirements](requirements.md)
- [Phase 1 design](docs/design.md)

> Sift is in early development (Phase 1: the command-line tool). It supports TypeScript and JavaScript. An MCP server and a VS Code extension come next.

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

You can edit summaries and step texts by hand and set `status: user-edited`. Don't edit `calls`, `effects`, `covers`, or the hashes: Sift derives them from the code.

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
- Values that look like secrets (API keys, tokens, private keys, high-entropy strings) are replaced with `<redacted>` before anything is sent; the run summary says how many.
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
npm run verify      # build, type-check (including tests), run tests
npm run sift -- --help
```

| Package | Purpose |
|---|---|
| `packages/core` | Language- and provider-independent engine: config, schema, sync pipeline, graph, prompts |
| `packages/adapter-typescript` | TypeScript/JavaScript language adapter |
| `packages/provider-claude-code` | AI provider using `claude -p` |
| `packages/rules` | Built-in framework rule packs |
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
