# Sift for VS Code

Readable, verified descriptions of what your code does, next to the code.

The extension runs Sift's engine for each workspace folder that has a `sift.config.yaml`, and shows

- the **logic document** of a source file (**Sift: Open Logic**, `Ctrl+Alt+L`; `.sift` files open as logic documents too). Each function or method is a collapsible section with a status badge, its summary, inputs and returns, effects, the nested steps, and warnings. Text written by the AI stays faint until you **Verify** it.
  - Hover a step to highlight its code; move the cursor in the code to mark the step that owns it. A stale description outlines the whole function instead.
  - Click a step to show its code. Ctrl+click (or F12) follows its call to the callee's logic, with a picker for interface implementations; Alt+click opens the callee's code. Hover the `→` after a step to see where its calls go, including library calls and their effects.
- a status bar item with the number of out-of-date or missing descriptions,
- a dot in the explorer on files whose logic is out of date or not described yet,
- an **Out of Date** view in the Sift sidebar, listing units by reason,
- **Callers** and **Callees** views for the function at the cursor (editor context menu), with edge confidence and unresolved calls listed,
- **diagrams** of the code around a function (**Show Neighbourhood Diagram**), of what an HTTP route does (**Show Route Flow…**, with effects on each box), and of what a change may affect (**Show Impact of Changing This**, **Show Impact of Uncommitted Changes**: a grouped list, with the diagram on request). Click a box to open its logic, Alt+click for its code, Shift+click for its neighbourhood. Dashed lines come from a rule pack or a name match; calls Sift could not resolve are listed in their own box. Diagrams follow the saved files and redraw after each save,
- **Describe This File**, **Describe Folder**, and **Update Out-of-Date Descriptions**, which always show an estimate (units, models, where the code is sent) and ask before calling the AI. A run can be cancelled; units already described are kept,
- **editing what the code does** through its description:
  - **Edit** on a unit (or **Sift: Edit Logic of This…** in the code's context menu) makes its summary, input and return meanings, and steps editable in place: click a text to change it (Enter keeps it, Escape cancels), `+` adds a step after one, `↳` inside an `if` or loop, `×` removes one, `↺` undoes your change. Or write what you want in **Ask for a change**. Your changes are marked in the document and kept as a draft.
  - **Propose change** plans the change, asks questions in the document when your request leaves something open, writes the code, and checks it (parses, type-checks, changes only what the plan allowed). It can be cancelled.
  - The **review** shows what Sift understood, the logic changes word by word, the code diff (**Open diff** for VS Code's diff editor), what else may be affected (units and routes), the checks that ran (**Run configured checks** runs your `edit.checks` on a copy of the project), and anything it did not do or was not asked for. A change that reaches beyond the unit asks you to confirm again.
  - **Approve and apply** writes the code through the editor, so VS Code's Undo works, and the new description. **Sift: Undo Edit…** (or **Undo** in the review) restores both, only if nothing changed them since.
  - If the code changes before you apply, the change is marked **Code changed**; **Re-plan on the current code** starts it over with the edits that still fit.

Without a Sift project, run **Sift: Initialize**.

Generating and editing use Claude Code on your own login, as the `sift` CLI does. Nothing is sent without your confirmation, and no code is written until you approve it. The `sift.updateOnSave` setting (`off` or `ask`) can offer an update after you save a file.
