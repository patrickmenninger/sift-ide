import ts from "typescript";
import type { CallSite, StructureNode } from "@sift/core";
import { headerText, isFunctionWithBody, rangeBetween, rangeOf, snippet, type FunctionWithBody } from "./names.js";

export interface ResolvedCall {
  site: CallSite;
  /** True for calls into the language's standard library (Math, Array, JSON…), which never count as effects. */
  standardLibrary: boolean;
}

export interface CallResolver {
  resolveCall(call: ts.CallExpression | ts.NewExpression, callbackKeys: Map<ts.Node, string>): ResolvedCall;
}

const key = (prefix: string, i: number | string) => (prefix === "" ? `${i}` : `${prefix}.${i}`);

/**
 * Builds the statement tree of a unit (design §3.1). Each node has a structural key such as
 * "2", "2.then.0", "2.else.1", "4.body.0", "5.try.0", "5.catch.0", "3.case1.0", or "3.cb0.0".
 * Calls are attached to the node whose own code contains them; calls inside inline functions
 * belong to that function's `callback` node instead.
 */
export class StructureBuilder {
  /** Calls into non-standard-library external code seen so far (for the lite-unit heuristic). */
  externalCalls = 0;

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly resolver: CallResolver,
  ) {}

  functionBody(fn: FunctionWithBody, prefix: string): StructureNode[] {
    const body = fn.body!;
    if (ts.isBlock(body)) return this.statements(body.statements, prefix);
    const k = key(prefix, 0);
    const own = this.own([body], k);
    return [{ key: k, kind: "return", range: rangeOf(body, this.sf), text: snippet(body.getText(this.sf)), calls: own.calls, children: own.callbacks }];
  }

  statements(stmts: readonly ts.Statement[], prefix: string): StructureNode[] {
    return stmts
      .filter((s) => !ts.isEmptyStatement(s) && !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s))
      .map((s, i) => this.statement(s, key(prefix, i)));
  }

  private statementsOf(stmt: ts.Statement, prefix: string): StructureNode[] {
    return ts.isBlock(stmt) ? this.statements(stmt.statements, prefix) : this.statements([stmt], prefix);
  }

  private statement(input: ts.Statement, k: string): StructureNode {
    let s = input;
    while (ts.isLabeledStatement(s)) s = s.statement;
    const range = rangeOf(s, this.sf);

    if (ts.isIfStatement(s)) {
      const own = this.own([s.expression], k);
      const children = [...own.callbacks, ...this.statementsOf(s.thenStatement, `${k}.then`)];
      if (s.elseStatement) {
        children.push({
          key: `${k}.else`,
          kind: "else",
          range: rangeOf(s.elseStatement, this.sf),
          text: "else",
          calls: [],
          children: this.statementsOf(s.elseStatement, `${k}.else`),
        });
      }
      return { key: k, kind: "if", range, text: `if (${snippet(s.expression.getText(this.sf))})`, calls: own.calls, children };
    }

    if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s)) {
      const parts: (ts.Node | undefined)[] = ts.isForStatement(s)
        ? [s.initializer, s.condition, s.incrementor]
        : ts.isForOfStatement(s) || ts.isForInStatement(s)
          ? [s.initializer, s.expression]
          : [s.expression];
      const own = this.own(parts.filter((p): p is ts.Node => p !== undefined), k);
      const text = ts.isDoStatement(s)
        ? `do … while (${snippet(s.expression.getText(this.sf))})`
        : snippet(this.sf.text.slice(s.getStart(this.sf), s.statement.getStart(this.sf)));
      return { key: k, kind: "loop", range, text, calls: own.calls, children: [...own.callbacks, ...this.statementsOf(s.statement, `${k}.body`)] };
    }

    if (ts.isTryStatement(s)) {
      const children = this.statements(s.tryBlock.statements, `${k}.try`);
      if (s.catchClause) {
        const c = s.catchClause;
        children.push({
          key: `${k}.catch`,
          kind: "catch",
          range: rangeOf(c, this.sf),
          text: c.variableDeclaration ? `catch (${c.variableDeclaration.getText(this.sf)})` : "catch",
          calls: [],
          children: this.statements(c.block.statements, `${k}.catch`),
        });
      }
      if (s.finallyBlock) {
        children.push({
          key: `${k}.finally`,
          kind: "finally",
          range: rangeOf(s.finallyBlock, this.sf),
          text: "finally",
          calls: [],
          children: this.statements(s.finallyBlock.statements, `${k}.finally`),
        });
      }
      return { key: k, kind: "try", range, text: "try", calls: [], children };
    }

    if (ts.isSwitchStatement(s)) {
      const own = this.own([s.expression], k);
      const cases: StructureNode[] = s.caseBlock.clauses.map((clause, n) => {
        const ck = `${k}.case${n}`;
        const caseOwn = ts.isCaseClause(clause) ? this.own([clause.expression], ck) : { calls: [], callbacks: [] };
        const body = clause.statements.length === 1 && ts.isBlock(clause.statements[0]!) ? clause.statements[0].statements : clause.statements;
        return {
          key: ck,
          kind: "case",
          range: rangeOf(clause, this.sf),
          text: ts.isCaseClause(clause) ? `case ${snippet(clause.expression.getText(this.sf))}:` : "default:",
          calls: caseOwn.calls,
          children: [...caseOwn.callbacks, ...this.statements(body, ck)],
        };
      });
      return { key: k, kind: "switch", range, text: `switch (${snippet(s.expression.getText(this.sf))})`, calls: own.calls, children: [...own.callbacks, ...cases] };
    }

    if (ts.isBlock(s)) {
      return { key: k, kind: "statement", range, text: "{ … }", calls: [], children: this.statements(s.statements, `${k}.body`) };
    }

    const own = this.own([s], k);
    const kind = ts.isReturnStatement(s) ? "return" : ts.isThrowStatement(s) ? "throw" : "statement";
    return { key: k, kind, range, text: snippet(s.getText(this.sf)), calls: own.calls, children: own.callbacks };
  }

  /** Calls and inline functions in a node's own code, not descending into nested functions. */
  private own(nodes: readonly ts.Node[], k: string): { calls: CallSite[]; callbacks: StructureNode[] } {
    const fns: FunctionWithBody[] = [];
    const calls: (ts.CallExpression | ts.NewExpression)[] = [];
    const visit = (n: ts.Node): void => {
      if (isFunctionWithBody(n)) {
        fns.push(n);
        return;
      }
      if ((ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) || ts.isNewExpression(n)) calls.push(n);
      ts.forEachChild(n, visit);
    };
    for (const node of nodes) visit(node);

    const callbackKeys = new Map<ts.Node, string>();
    fns.forEach((fn, i) => callbackKeys.set(fn, `${k}.cb${i}`));
    const callbacks: StructureNode[] = fns.map((fn) => {
      const ck = callbackKeys.get(fn)!;
      return {
        key: ck,
        kind: "callback",
        range: rangeBetween(fn.getStart(this.sf), fn.getEnd(), this.sf),
        text: headerText(fn, fn, this.sf),
        calls: [],
        children: this.functionBody(fn, ck),
      };
    });

    const sites = calls.map((c) => {
      const resolved = this.resolver.resolveCall(c, callbackKeys);
      if (resolved.site.external && !resolved.standardLibrary) this.externalCalls++;
      return resolved.site;
    });
    return { calls: sites, callbacks };
  }
}

/** Does the function return JSX (making it a UI component)? */
export function returnsJsx(fn: FunctionWithBody): boolean {
  const isJsx = (e: ts.Node | undefined): boolean => {
    let x = e;
    while (x && ts.isParenthesizedExpression(x)) x = x.expression;
    return !!x && (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x));
  };
  const body = fn.body!;
  if (!ts.isBlock(body)) return isJsx(body);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || (n !== body && isFunctionWithBody(n))) return;
    if (ts.isReturnStatement(n) && isJsx(n.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

export function flatten(nodes: readonly StructureNode[]): StructureNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
