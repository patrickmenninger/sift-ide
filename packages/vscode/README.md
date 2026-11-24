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
- **Describe This File**, **Describe Folder**, and **Update Out-of-Date Descriptions**, which always show an estimate (units, models, where the code is sent) and ask before calling the AI. A run can be cancelled; units already described are kept.

Without a Sift project, run **Sift: Initialize**.

Generating uses Claude Code on your own login, as the `sift` CLI does. Nothing is sent without your confirmation. The `sift.updateOnSave` setting (`off` or `ask`) can offer an update after you save a file.

Editing logic arrives in a later milestone.
