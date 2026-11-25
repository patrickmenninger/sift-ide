/**
 * What the extension and webview bundles take from @sift/core at runtime (esbuild aliases the
 * package to this file). Core reads its prompts and model maps from disk when it loads, which only
 * the server process does; the others need the error type and the pure description edits (a
 * draft is shown as the person edits it). Types still come from @sift/core itself.
 */
export { SiftError, type SiftErrorCode } from "../../core/src/errors.js";
export { applyDescriptionEdits, findStep } from "../../core/src/description-edits.js";
