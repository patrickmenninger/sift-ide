import { existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import ts from "typescript";
import {
  SiftError,
  type AdapterOptions,
  type AdapterProject,
  type CallArg,
  type CallSite,
  type ExtractedUnit,
  type FileExtraction,
  type SymbolRef,
} from "@sift/core";
import { hashNodes } from "./hash.js";
import {
  declName,
  externalModuleOf,
  headerText,
  isFunctionWithBody,
  namedDeclarationFor,
  qualifiedName,
  rangeBetween,
  rangeOf,
  snippet,
  toProjectPath,
  unwrap,
  type FunctionWithBody,
} from "./names.js";
import { flatten, returnsJsx, StructureBuilder, type CallResolver, type ResolvedCall } from "./structure.js";
import { discoverUnits, MODULE_SYMBOL, type DiscoveredUnit } from "./units.js";

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const NON_LITE_KINDS = new Set(["if", "else", "switch", "case", "loop", "try", "catch", "finally", "throw", "callback"]);

/** Declarations that can be the target of a call into project code. */
function isCallableDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer !== undefined &&
      isFunctionWithBody(unwrap(node.initializer)))
  );
}

/** A function or method with a body: something a reference can point to as code (not a type member or a class). */
function hasImplementation(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.body !== undefined;
  }
  return (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
    node.initializer !== undefined &&
    isFunctionWithBody(unwrap(node.initializer))
  );
}

/** Interface members and abstract methods: calls to these dispatch to implementations. */
function isAbstractMember(node: ts.Node): boolean {
  if ((ts.isMethodSignature(node) || ts.isPropertySignature(node)) && ts.isInterfaceDeclaration(node.parent)) return true;
  return ts.isMethodDeclaration(node) && !node.body && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
}

export class TsProject implements AdapterProject, CallResolver {
  private readonly checker: ts.TypeChecker;
  private readonly liteMaxStatements: number;
  private implementationIndex: Map<string, ts.ClassLikeDeclaration[]> | undefined;
  private unitNameIndex: Map<string, SymbolRef[]> | undefined;

  constructor(
    private readonly root: string,
    private readonly program: ts.Program,
    options: AdapterOptions = {},
  ) {
    this.checker = program.getTypeChecker();
    this.liteMaxStatements = options.liteMaxStatements ?? 3;
  }

  extractFile(path: string): FileExtraction {
    const abs = (isAbsolute(path) ? path : join(this.root, path)).replace(/\\/g, "/");
    const sf = this.program.getSourceFile(abs);
    if (!sf) {
      throw new SiftError(
        "SOURCE_NOT_FOUND",
        existsSync(abs) ? `${path} is not part of the TypeScript project (check tsconfig "include").` : `${path} does not exist.`,
      );
    }
    return {
      path: this.rel(sf.fileName),
      language: JS_EXTENSIONS.has(extname(sf.fileName)) ? "javascript" : "typescript",
      fileHash: hashNodes([sf], sf),
      units: discoverUnits(sf).map((u) => this.buildUnit(u, sf)),
    };
  }

  findImplementations(ref: SymbolRef): SymbolRef[] {
    const dot = ref.symbol.lastIndexOf(".");
    if (dot < 0) return [];
    const owner = ref.symbol.slice(0, dot);
    const member = ref.symbol.slice(dot + 1);
    const result: SymbolRef[] = [];
    for (const cls of this.implementations().get(`${ref.file}#${owner}`) ?? []) {
      for (const m of cls.members) {
        const hasBody =
          ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body !== undefined) ||
          (ts.isPropertyDeclaration(m) && m.initializer !== undefined && isFunctionWithBody(unwrap(m.initializer)));
        if (hasBody && declName(m) === member) result.push({ file: this.rel(m.getSourceFile().fileName), symbol: qualifiedName(m) });
      }
    }
    return result.sort((a, b) => `${a.file}#${a.symbol}`.localeCompare(`${b.file}#${b.symbol}`));
  }

  dispose(): void {
    this.implementationIndex = undefined;
    this.unitNameIndex = undefined;
  }

  // ---------------------------------------------------------------- units

  private buildUnit(u: DiscoveredUnit, sf: ts.SourceFile): ExtractedUnit {
    const builder = new StructureBuilder(sf, this);
    const body = u.fn ? builder.functionBody(u.fn, "") : builder.statements(u.statements, "");
    const all = flatten(body);
    const isSmall =
      u.kind !== "module" &&
      builder.externalCalls === 0 &&
      all.length <= this.liteMaxStatements &&
      all.every((n) => !NON_LITE_KINDS.has(n.kind));

    if (!u.fn) {
      const last = u.statements[u.statements.length - 1]!;
      return {
        symbol: MODULE_SYMBOL,
        kind: "module",
        isSmall: false,
        signature: MODULE_SYMBOL,
        inputs: [],
        returns: null,
        bodyHash: hashNodes(u.statements, sf),
        range: rangeBetween(u.statements[0]!.getStart(sf), last.getEnd(), sf),
        body,
        docComment: null,
        sourceText: u.statements.map((s) => s.getText(sf)).join("\n"),
        typeRefs: this.typeRefs(u.statements),
        implementsMember: null,
      };
    }

    const fn = u.fn;
    return {
      symbol: u.symbol,
      kind: u.kind === "function" && returnsJsx(fn) ? "component" : u.kind,
      isSmall,
      signature: headerText(fn, u.outer, sf),
      inputs: fn.parameters
        .filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"))
        .map((p) => {
          const jsDocType = ts.getJSDocType(p);
          const written = p.type ?? jsDocType;
          const name = `${p.dotDotDotToken ? "..." : ""}${p.name.getText(sf)}${p.questionToken ? "?" : ""}`;
          return {
            name,
            type: written ? written.getText(sf) : this.typeText(this.checker.getTypeAtLocation(p)),
            typeInferred: written === undefined,
          };
        }),
      returns: this.returnType(fn, sf),
      bodyHash: hashNodes([u.decl], sf),
      range: rangeOf(u.outer, sf),
      body,
      docComment: leadingComments(u.outer, sf),
      sourceText: u.outer.getText(sf),
      typeRefs: this.typeRefs([u.decl]),
      implementsMember: this.implementsMember(u.decl),
    };
  }

  private returnType(fn: FunctionWithBody, sf: ts.SourceFile): ExtractedUnit["returns"] {
    if (ts.isConstructorDeclaration(fn)) return null;
    const written = fn.type ?? ts.getJSDocReturnType(fn);
    if (written) return { type: written.getText(sf), typeInferred: false };
    const signature = this.checker.getSignatureFromDeclaration(fn);
    if (!signature) return null;
    return { type: this.typeText(this.checker.getReturnTypeOfSignature(signature)), typeInferred: true };
  }

  private typeText(type: ts.Type): string {
    return this.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  }

  private typeRefs(nodes: readonly ts.Node[]): SymbolRef[] {
    const refs = new Map<string, SymbolRef>();
    const visit = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n)) {
        const decl = this.declarationOf(n.typeName);
        if (
          decl &&
          this.isProjectNode(decl) &&
          (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl))
        ) {
          const ref = { file: this.rel(decl.getSourceFile().fileName), symbol: qualifiedName(decl) };
          refs.set(`${ref.file}#${ref.symbol}`, ref);
        }
      }
      ts.forEachChild(n, visit);
    };
    nodes.forEach(visit);
    return [...refs.values()];
  }

  private implementsMember(decl: ts.Node): SymbolRef | null {
    const cls = decl.parent;
    if (!cls || !ts.isClassLike(cls) || !ts.isClassElement(decl)) return null;
    const name = decl.name && (ts.isIdentifier(decl.name) || ts.isPrivateIdentifier(decl.name)) ? decl.name.text : undefined;
    if (!name) return null;
    for (const clause of cls.heritageClauses ?? []) {
      for (const t of clause.types) {
        const member = this.checker.getTypeAtLocation(t).getProperty(name);
        const target = member?.declarations?.find((d) => d !== decl);
        if (target && this.isProjectNode(target)) return { file: this.rel(target.getSourceFile().fileName), symbol: qualifiedName(target) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- calls

  resolveCall(call: ts.CallExpression | ts.NewExpression, callbackKeys: Map<ts.Node, string>): ResolvedCall {
    const sf = call.getSourceFile();
    const site: CallSite = {
      expression: snippet(call.getText(sf), 200),
      target: null,
      confidence: null,
      implementations: [],
      external: null,
      awaited: isAwaited(call),
      args: (call.arguments ?? []).map((a) => this.callArg(a, callbackKeys)),
      range: rangeOf(call, sf),
    };
    let standardLibrary = false;

    const decl = this.callTarget(call);
    if (decl && !this.isProjectNode(decl)) {
      site.external = { module: externalModuleOf(decl, this.program), name: qualifiedName(decl) };
      site.confidence = "resolved";
      standardLibrary = this.program.isSourceFileDefaultLibrary(decl.getSourceFile());
    } else if (decl && isCallableDeclaration(namedDeclarationFor(decl))) {
      const named = namedDeclarationFor(decl);
      site.target = { file: this.rel(named.getSourceFile().fileName), symbol: qualifiedName(named) };
      site.confidence = "resolved";
      if (isAbstractMember(named)) site.implementations = this.findImplementations(site.target);
    } else if (!decl) {
      const match = this.nameMatch(call);
      if (match) {
        site.target = match;
        site.confidence = "name-match";
      }
    }
    return { site, standardLibrary };
  }

  /** The declaration a call runs, or undefined when it can't be determined statically. */
  private callTarget(call: ts.CallExpression | ts.NewExpression): ts.Node | undefined {
    if (ts.isNewExpression(call)) {
      // Prefer the class itself: an inherited constructor would otherwise resolve to the base class (e.g. Error).
      const cls = this.declarationOf(call.expression);
      if (cls && ts.isClassLike(cls)) {
        const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined);
        return ctor ?? cls;
      }
      return cls;
    }
    const signature = this.checker.getResolvedSignature(call);
    const fromSignature = signature?.declaration;
    // A call through a function-typed variable or parameter resolves to the function type, not to code;
    // resolveCall treats a project function type as an unresolved (dynamic) call.
    if (fromSignature && !ts.isJSDocSignature(fromSignature)) return fromSignature;
    return this.declarationOf(calleeName(call.expression));
  }

  private nameMatch(call: ts.CallExpression | ts.NewExpression): SymbolRef | null {
    const callee = call.expression;
    if (!(this.checker.getTypeAtLocation(callee).flags & ts.TypeFlags.Any)) return null;
    const nameNode = calleeName(callee);
    if (!ts.isIdentifier(nameNode)) return null;
    const candidates = this.unitNames().get(nameNode.text) ?? [];
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private callArg(arg: ts.Expression, callbackKeys: Map<ts.Node, string>): CallArg {
    const e = unwrap(arg);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { kind: "string", value: e.text };
    if (isFunctionWithBody(e)) {
      const key = callbackKeys.get(e);
      return key ? { kind: "callback", key } : { kind: "unknown" };
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const decl = this.declarationOf(e);
      const named = decl && namedDeclarationFor(decl);
      if (named && this.isProjectNode(named) && hasImplementation(named)) {
        return { kind: "unit", ref: { file: this.rel(named.getSourceFile().fileName), symbol: qualifiedName(named) } };
      }
    }
    return { kind: "unknown" };
  }

  // ---------------------------------------------------------------- indexes

  private implementations(): Map<string, ts.ClassLikeDeclaration[]> {
    if (this.implementationIndex) return this.implementationIndex;
    const index = new Map<string, ts.ClassLikeDeclaration[]>();
    const visit = (n: ts.Node): void => {
      if (ts.isClassLike(n)) {
        for (const clause of n.heritageClauses ?? []) {
          for (const t of clause.types) {
            const base = this.declarationOf(t.expression);
            if (base && this.isProjectNode(base)) {
              const k = `${this.rel(base.getSourceFile().fileName)}#${qualifiedName(base)}`;
              index.set(k, [...(index.get(k) ?? []), n]);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    this.projectFiles().forEach(visit);
    this.implementationIndex = index;
    return index;
  }

  private unitNames(): Map<string, SymbolRef[]> {
    if (this.unitNameIndex) return this.unitNameIndex;
    const index = new Map<string, SymbolRef[]>();
    for (const sf of this.projectFiles()) {
      for (const u of discoverUnits(sf)) {
        if (u.kind === "module") continue;
        const simple = u.symbol.slice(u.symbol.lastIndexOf(".") + 1);
        index.set(simple, [...(index.get(simple) ?? []), { file: this.rel(sf.fileName), symbol: u.symbol }]);
      }
    }
    this.unitNameIndex = index;
    return index;
  }

  // ---------------------------------------------------------------- helpers

  private declarationOf(node: ts.Node): ts.Declaration | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  private projectFiles(): ts.SourceFile[] {
    return this.program.getSourceFiles().filter((sf) => this.isProjectFile(sf));
  }

  private isProjectFile(sf: ts.SourceFile): boolean {
    if (sf.isDeclarationFile || this.program.isSourceFileDefaultLibrary(sf)) return false;
    const path = sf.fileName.replace(/\\/g, "/");
    if (path.includes("/node_modules/")) return false;
    const rel = this.rel(path);
    return !rel.startsWith("../") && !isAbsolute(rel);
  }

  private isProjectNode(node: ts.Node): boolean {
    return this.isProjectFile(node.getSourceFile());
  }

  private rel(fileName: string): string {
    return toProjectPath(this.root, resolve(fileName));
  }
}

function calleeName(callee: ts.Expression): ts.Node {
  const e = unwrap(callee);
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return e;
}

function isAwaited(call: ts.Node): boolean {
  let p = call.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return !!p && ts.isAwaitExpression(p);
}

/** Comments directly above a node (no blank line between them), e.g. JSDoc or `//` notes. */
function leadingComments(node: ts.Node, sf: ts.SourceFile): string | null {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const kept: string[] = [];
  let nextLine = lineOf(node.getStart(sf));
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    if (nextLine - lineOf(r.end) > 1) break;
    kept.unshift(sf.text.slice(r.pos, r.end));
    nextLine = lineOf(r.pos);
  }
  return kept.length > 0 ? kept.join("\n") : null;
}
