# VS Code Extension Limits

A running list of things the extension API made hard or impossible (requirements §9.1: "limits that would justify a fork"), started in M11. Each entry says what we wanted, what the API allows, and what we did instead. An entry is not a reason to fork on its own; the list is for deciding later whether the sum is.

| # | Wanted | What the API allows | What we did | Since |
|---|---|---|---|---|
| 1 | Show the cost estimate and the list of units in the confirmation before generating, with the units scrollable. | Modal messages take one line plus a plain-text `detail`; no lists, links, or scrolling. A webview panel is not modal. | Units and models grouped per task in `detail`; the full list is in the dry run (`sift generate --dry-run`). | M11 |
| 2 | Decorate a file in the explorer with a dot whose meaning is readable without hovering (stale vs. not described). | `FileDecoration` gives a badge of at most two characters, a colour, and a tooltip. | Same dot, two theme colours (`sift.staleLogicForeground`, `sift.missingLogicForeground`); the tooltip says which. | M11 |
| 3 | Run the engine in the extension host's own process for low latency. | Long synchronous work (a TypeScript program build) blocks every extension (§3). | A child process per workspace folder over JSON-RPC, as planned. Startup costs one Node process and loading a 3.7 MB bundle. | M11 |
