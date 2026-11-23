/**
 * What the extension bundle takes from @sift/core at runtime (esbuild aliases the package to this
 * file). Core reads its prompts and model maps from disk when it loads, which only the server
 * process does; the extension host needs nothing but the error type. Types still come from
 * @sift/core itself.
 */
export { SiftError, type SiftErrorCode } from "../../core/src/errors.js";
