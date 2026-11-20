import ts from "typescript";
import { hashNodes } from "./hash.js";

/** Normalized hash of a whole file without creating a program; matches `FileExtraction.fileHash`. */
export function hashFileText(path: string, text: string): string {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return hashNodes([sf], sf);
}
