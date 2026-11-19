import { relative } from "node:path";
import ts from "typescript";
import type { SourceRange } from "@sift/core";

export type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

/** Strip parentheses, `as`, `satisfies`, and non-null assertions. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** The node that names a function: `const x = () => {}` is named by the variable declaration. */
export function namedDeclarationFor(node: ts.Node): ts.Node {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
    let p = node.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent;
    if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isExportAssignment(p))) {
      return p;
    }
  }
  return node;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/** The simple name of a declaration, or undefined if it has none. */
export function declName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isExportAssignment(node)) return "default";
  const name = (node as { name?: ts.Node }).name;
  let base: string | undefined;
  if (name) {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) base = name.text;
    else if (ts.isComputedPropertyName(name)) base = `[${name.expression.getText()}]`;
    else base = name.getText();
  } else if (hasDefaultModifier(node)) base = "default";
  if (base === undefined) return undefined;
  if (ts.isGetAccessorDeclaration(node)) return `get ${base}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${base}`;
  return base;
}

/**
 * Qualified name of a declaration within its file or ambient module,
 * e.g. "AccountService.transferFunds" or "Prisma.AccountDelegate.update".
 */
export function qualifiedName(declaration: ts.Node): string {
  let node = namedDeclarationFor(declaration);
  // Anonymous function types take the name of what declares them: `type Handler = (req) => void` → "Handler".
  while (declName(node) === undefined && node.parent && !ts.isSourceFile(node.parent) && !ts.isModuleBlock(node.parent)) {
    node = node.parent;
  }
  const parts: string[] = [declName(node) ?? "<anonymous>"];
  let p: ts.Node | undefined = node.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isModuleDeclaration(p)) {
      if (ts.isStringLiteral(p.name) || isGlobalAugmentation(p)) break;
      parts.unshift(p.name.text);
    } else if (ts.isClassLike(p) || ts.isInterfaceDeclaration(p)) {
      parts.unshift(declName(p) ?? "<anonymous>");
    } else if (ts.isObjectLiteralExpression(p)) {
      const owner: ts.Node = p.parent;
      if (owner && (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner))) {
        parts.unshift(declName(owner) ?? "<anonymous>");
        p = owner;
      }
    }
    p = p.parent;
  }
  return parts.join(".");
}

/** Module a library declaration belongs to: an ambient module name, a package name, or "global". */
export function externalModuleOf(declaration: ts.Node, program: ts.Program): string {
  for (let p: ts.Node | undefined = declaration.parent; p; p = p.parent) {
    if (ts.isModuleDeclaration(p)) {
      if (ts.isStringLiteral(p.name)) return p.name.text;
      if (isGlobalAugmentation(p)) return "global";
    }
  }
  const sf = declaration.getSourceFile();
  if (program.isSourceFileDefaultLibrary(sf)) return "global";
  const path = sf.fileName.replace(/\\/g, "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at >= 0 && ts.isExternalModule(sf)) {
    const segments = path.slice(at + "/node_modules/".length).split("/");
    let pkg = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
    if (pkg.startsWith("@types/")) {
      const name = pkg.slice("@types/".length);
      pkg = name.includes("__") ? `@${name.replace("__", "/")}` : name;
    }
    return pkg;
  }
  return "global";
}

export function toProjectPath(root: string, fileName: string): string {
  return relative(root, fileName).replace(/\\/g, "/");
}

export function rangeOf(node: ts.Node, sf: ts.SourceFile): SourceRange {
  return rangeBetween(node.getStart(sf), node.getEnd(), sf);
}

export function rangeBetween(start: number, end: number, sf: ts.SourceFile): SourceRange {
  const s = sf.getLineAndCharacterOfPosition(start);
  const e = sf.getLineAndCharacterOfPosition(end);
  return { start: { line: s.line + 1, col: s.character + 1 }, end: { line: e.line + 1, col: e.character + 1 } };
}

/** Collapse whitespace and cap length, for human-readable snippets. */
export function snippet(text: string, max = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Source text from a node's start up to (not including) its body: "async save(account: Account): Promise<void>". */
export function headerText(fn: FunctionWithBody, start: ts.Node, sf: ts.SourceFile): string {
  const text = sf.text.slice(start.getStart(sf), fn.body!.getStart(sf));
  return snippet(text).replace(/\s*=>\s*$/, "");
}

/** `declare global { … }` */
function isGlobalAugmentation(node: ts.ModuleDeclaration): boolean {
  return (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}
