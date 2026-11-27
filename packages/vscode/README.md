# Sift for VS Code

Readable, verified descriptions of what your code does, next to the code.

Sift writes a plain-language description of every function, method, and component in a TypeScript or JavaScript project: what it does step by step, what it calls, its side effects (database, network, files), and what looks wrong. This extension shows those descriptions beside your code, keeps them in sync, draws the code around a function, and lets you change code by editing its description, with a review before anything is written.

## Requirements

- **VS Code 1.100** or later.
- **Claude Code**, installed and logged in. Describing and editing run `claude -p` on your own login; no API key is needed. Run `claude` once in a terminal and use `/login` if you haven't. If `claude` isn't on your PATH, set the `SIFT_CLAUDE_COMMAND` environment variable to its full path before starting VS Code.
- Browsing descriptions that already exist, the views, and the diagrams make no AI calls and work without Claude Code.

The Sift engine is bundled: you don't need the `sift` CLI or Node.js installed.

## Install

The extension isn't on the marketplace yet. Build the `.vsix` from the repository root and install it:

```sh
npm install
npm run package:vscode
code --install-extension packages/vscode/sift.vsix
```

Or use **Extensions: Install from VSIX…** in the Command Palette. CI builds the same `.vsix` on every push (the `sift-vsix` artifact).

## Getting started

1. Open a project. If it has no `sift.config.yaml`, run **Sift: Initialize** and check `include` / `exclude` in the new config.
2. Open a source file and run **Sift: Describe This File** (the sparkle button in the editor title). Sift shows what it will send to which models, with an estimate, and asks first.
3. Press `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS) to open the file's **logic document** beside the code.
4. Read a description and click **Verify** when you agree with it.

Commit `sift.config.yaml` and the `.sift/` folder so your team shares the descriptions.

## The logic document

**Sift: Open Logic** shows a source file's logic beside it; `.sift` files open as logic documents too. Each function or method is a collapsible section with a status badge, its summary, inputs and returns, effects, nested steps, and warnings.

| Badge | Meaning |
|---|---|
| Unverified | Written by the AI, not checked yet. The text stays faint until you **Verify** it. |
| Edited | A person changed the wording; sync keeps it. |
| Verified | Checked by a person. |
| Stale | The code changed since it was described. The whole function is outlined in the code instead of single steps. |

Moving between logic and code:

| Do this | To |
|---|---|
| Hover a step | Highlight its code |
| Move the cursor in the code | Mark the step that owns it |
| Click a step | Show its code |
| Ctrl+click (or F12) a step | Follow its call to the callee's logic, with a picker when an interface has several implementations |
| Alt+click a step | Open the callee's code |
| Hover the `→` after a step | See where its calls go, including library calls and their effects |
| **Open Source** (editor title) | Go from a `.sift` file to its code |

The document says when the source has unsaved changes; once you save, changed units show as stale.

## Keeping descriptions in sync

- The **status bar** shows how many descriptions are out of date or missing; click it for the list. A dot in the **explorer** marks files whose logic is out of date (or not described yet; the tooltip says which).
- The **Out of Date** view in the Sift sidebar lists units by reason. Its title bar updates everything; each entry can be updated on its own.
- **Describe This File**, **Describe Folder** (explorer context menu), and **Update Out-of-Date Descriptions** always show an estimate (units, models, where the code is sent) and ask before calling the AI. A run can be cancelled; units already described are kept.
- With `sift.updateOnSave` set to `ask`, saving a file whose logic is now out of date offers an update.

## Exploring the code

From the editor's context menu, for the function at the cursor:

- **Show Callers** / **Show Callees**: tree views with how each call was resolved, the calls Sift couldn't resolve, and a button to go to each call site.
- **Show Neighbourhood Diagram**: the function with its callers, callees, interface members and their implementations, routes, and events.
- **Show Impact of Changing This**: what may be affected, grouped by distance with the weakest confidence on each path, and a diagram on request.

From the Command Palette (or the Out of Date view's `…` menu):

- **Show Route Flow…**: an HTTP route from its handler down to library calls, with effects as chips on each box.
- **Show Impact of Uncommitted Changes**: the same impact list for everything changed since your last commit.

In a diagram, click a box to open its logic, Alt+click for its code, Shift+click for its neighbourhood; a route opens its flow. Dashed lines come from a rule pack or a name match rather than the type checker; unresolved calls get their own box. Diagrams redraw after each save.

## Changing code through its description

1. **Edit** on a unit in its logic document (or **Sift: Edit Logic of This…** from the code's context menu) makes its summary, input and return meanings, and steps editable. Click a text to change it (Enter keeps it, Escape cancels); `+` adds a step after one, `↳` adds one inside an `if` or loop, `×` removes one, `↺` undoes your change. Or describe what you want in **Ask for a change**. Your changes are kept as a draft.
2. **Propose change** plans the change and asks its questions in the document when your request leaves something open (what happens on failure, who may do it). It then writes the code and checks that it parses, type-checks, and changes only what the plan allowed. It can be cancelled.
3. The **review** shows what Sift understood, the logic changes word by word, the code diff (**Open diff** for VS Code's diff editor), what else may be affected, the checks that ran (**Run configured checks** runs your `edit.checks` on a copy of the project), and anything it didn't do or wasn't asked for. A change that reaches other units asks you to confirm again.
4. **Approve and apply** writes the code through the editor, so VS Code's Undo works, then the new description. **Sift: Undo Edit…** (or **Undo** in the review) restores both, as long as nothing has changed them since.

If the code changes before you apply, the draft is marked **Code changed**; **Re-plan on the current code** starts again with the edits that still fit. A rewording that doesn't change behaviour is kept only if it's still accurate, and no code is generated for it.

Edits replace functions, methods, and components (and may add imports). They can't yet change an interface, type alias, or class declaration: a request that needs one changed first stops and says what to change by hand.

## Commands

| Command | Where |
|---|---|
| Sift: Initialize | Command Palette |
| Sift: Open Logic (`Ctrl+Alt+L`) | Editor title, editor and explorer context menus |
| Sift: Describe This File | Editor title, explorer context menu |
| Sift: Describe Folder | Explorer context menu |
| Sift: Update Out-of-Date Descriptions | Out of Date view |
| Sift: Edit Logic of This… | Editor context menu |
| Sift: Undo Edit… | Out of Date view `…` menu |
| Sift: Show Callers / Show Callees | Editor context menu |
| Sift: Show Neighbourhood Diagram | Editor context menu |
| Sift: Show Impact of Changing This | Editor context menu |
| Sift: Show Impact of Uncommitted Changes | Out of Date view `…` menu |
| Sift: Show Route Flow… | Out of Date view `…` menu |
| Sift: Restart Server | Command Palette |
| Sift: Show Output | Command Palette |

## Settings

| Setting | Values | |
|---|---|---|
| `sift.updateOnSave` | `off` (default), `ask` | After you save a file whose logic is now out of date, offer to update it. You confirm the estimate first. |

Project settings (which files are described, models, rule packs, `edit.checks`) live in `sift.config.yaml`; see Configuration in the Sift repository's README.

## Privacy

- Sift sends each function's code, with the signatures and summaries of what it calls, to Anthropic through Claude Code on your own login. Editing also sends the code of the units it may change, their files' imports, the project types they use, and a few similar functions as examples.
- Values that look like secrets are replaced with `<redacted>` before anything is sent.
- Nothing is sent without your confirmation, and no code is written until you approve it.

## Troubleshooting

| Problem | What to do |
|---|---|
| Sift commands are greyed out | The folder has no `sift.config.yaml`. Run **Sift: Initialize**. |
| The status bar shows an error | Click it (or run **Sift: Show Output**) to see why. The engine restarts after a crash, and stops trying after three crashes in three minutes; run **Sift: Restart Server** once the cause is fixed. |
| `Claude Code is not logged in` | Run `claude` in a terminal, use `/login`, then try again. |
| A call shows as not resolved | The code didn't type-check at that call, or the call is dynamic. Fix the types, or add a rule pack. |

The engine runs as a separate process for each workspace folder, so a large project never blocks the editor.
