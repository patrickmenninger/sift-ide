import { createHash } from "node:crypto";
import ts from "typescript";

/**
 * The token texts of a node, with comments, JSDoc, and whitespace removed (design §5).
 * Formatting-only and comment-only edits therefore leave the result unchanged.
 */
export function normalizedTokens(node: ts.Node, sf: ts.SourceFile, out: string[] = []): string[] {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return out;
  const children = node.getChildren(sf);
  if (children.length === 0) {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return out;
    let text = node.getText(sf);
    if (node.kind === ts.SyntaxKind.JsxText) text = text.replace(/\s+/g, " ").trim();
    if (text !== "") out.push(text);
    return out;
  }
  for (const child of children) normalizedTokens(child, sf, out);
  return out;
}

export function hashNodes(nodes: readonly ts.Node[], sf: ts.SourceFile): string {
  const tokens: string[] = [];
  for (const node of nodes) normalizedTokens(node, sf, tokens);
  return createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
}
