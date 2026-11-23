# Sift for VS Code

Readable, verified descriptions of what your code does, next to the code.

This is the extension shell (Phase 2, M11): it runs Sift's engine for each workspace folder that has a `sift.config.yaml`, and shows

- a status bar item with the number of out-of-date or missing descriptions,
- a dot in the explorer on files whose logic is out of date or not described yet,
- an **Out of Date** view in the Sift sidebar, listing units by reason,
- **Callers** and **Callees** views for the function at the cursor (editor context menu), with edge confidence and unresolved calls listed,
- **Describe This File**, **Describe Folder**, and **Update Out-of-Date Descriptions**, which always show an estimate (units, models, where the code is sent) and ask before calling the AI. A run can be cancelled; units already described are kept.

Without a Sift project, run **Sift: Initialize**.

Generating uses Claude Code on your own login, as the `sift` CLI does. Nothing is sent without your confirmation. The `sift.updateOnSave` setting (`off` or `ask`) can offer an update after you save a file.

The logic document, step highlighting, and graph diagrams arrive in later milestones.
