import ts from "typescript";
import type { UnitKind } from "@sift/core";
import { isFunctionWithBody, qualifiedName, unwrap, type FunctionWithBody } from "./names.js";

export const MODULE_SYMBOL = "<module>";

export interface DiscoveredUnit {
  symbol: string;
  kind: Exclude<UnitKind, "component">;
  /** Declaration that names the unit (used for hashing and naming). */
  decl: ts.Node;
  /** The function, or null for the module unit. */
  fn: FunctionWithBody | null;
  /** Node whose range, text, and leading comments represent the unit. */
  outer: ts.Node;
  /** Module unit only: the top-level statements that do work. */
  statements: ts.Statement[];
}

/** Find every unit in a file: functions, methods, constructors, and module-level work (design §3.2). */
export function discoverUnits(sf: ts.SourceFile): DiscoveredUnit[] {
  const units: DiscoveredUnit[] = [];
  const moduleStatements: ts.Statement[] = [];
  const add = (kind: DiscoveredUnit["kind"], decl: ts.Node, fn: FunctionWithBody, outer: ts.Node) =>
    units.push({ symbol: qualifiedName(decl), kind, decl, fn, outer, statements: [] });

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.body) add("function", stmt, stmt, stmt);
    } else if (ts.isClassDeclaration(stmt)) {
      addClassMembers(stmt, add);
    } else if (ts.isVariableStatement(stmt)) {
      let doesWork = false;
      const single = stmt.declarationList.declarations.length === 1;
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer ? unwrap(d.initializer) : undefined;
        if (init && isFunctionWithBody(init)) add("function", d, init, single ? stmt : d);
        else if (init && ts.isObjectLiteralExpression(init)) {
          addObjectMembers(init, add);
          if (containsWork(init)) doesWork = true;
        } else if (init && ts.isClassExpression(init)) addClassMembers(init, add);
        else if (init && containsWork(init)) doesWork = true;
      }
      if (doesWork) moduleStatements.push(stmt);
    } else if (ts.isExportAssignment(stmt)) {
      const expr = unwrap(stmt.expression);
      if (isFunctionWithBody(expr)) add("function", stmt, expr, stmt);
      else if (containsWork(expr)) moduleStatements.push(stmt);
    } else if (!isDeclarationOnly(stmt)) {
      moduleStatements.push(stmt);
    }
  }

  if (moduleStatements.length > 0) {
    const first = moduleStatements[0]!;
    units.push({ symbol: MODULE_SYMBOL, kind: "module", decl: first, fn: null, outer: first, statements: moduleStatements });
  }
  return units.sort((a, b) => a.outer.getStart(sf) - b.outer.getStart(sf));
}

type Add = (kind: DiscoveredUnit["kind"], decl: ts.Node, fn: FunctionWithBody, outer: ts.Node) => void;

function addClassMembers(cls: ts.ClassLikeDeclaration, add: Add): void {
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m) && m.body) add("constructor", m, m, m);
    else if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body) add("method", m, m, m);
    else if (ts.isPropertyDeclaration(m) && m.initializer) {
      const init = unwrap(m.initializer);
      if (isFunctionWithBody(init)) add("method", m, init, m);
    }
  }
}

function addObjectMembers(obj: ts.ObjectLiteralExpression, add: Add): void {
  for (const p of obj.properties) {
    if ((ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.body) add("method", p, p, p);
    else if (ts.isPropertyAssignment(p)) {
      const init = unwrap(p.initializer);
      if (isFunctionWithBody(init)) add("method", p, init, p);
    }
  }
}

function isDeclarationOnly(stmt: ts.Statement): boolean {
  return (
    ts.isImportDeclaration(stmt) ||
    ts.isImportEqualsDeclaration(stmt) ||
    ts.isExportDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt) ||
    ts.isEmptyStatement(stmt)
  );
}

/** Does evaluating this expression do anything (call, construct, await) outside nested functions? */
function containsWork(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionWithBody(n)) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) || ts.isTaggedTemplateExpression(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
