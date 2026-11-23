import { isAbsolute, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listSiftFiles, SiftError, type CodeGraph, type GapNote, type LogicFile, type QueryHit, type Workspace } from "@sift/core";
import { cap, DEFAULT_DEPTH, MAX_RESULTS, renderUnit, staleNote, truncationNote, unitView, type Truncated, type UnitView } from "./views.js";

export interface McpOptions {
  workspace: Workspace;
  /** Register `sift_generate`, which spends the user's AI quota. Off unless `--allow-generate`. */
  allowGenerate?: boolean;
  /** Reported to the client. */
  version: string;
}

const INSTRUCTIONS = `Sift keeps plain-language descriptions of what each function in this project does, and a graph of who calls what.
- Before reading or changing a function, sift_describe it (or its file) for its steps, call targets, effects, and warnings.
- Before changing code, sift_impact the symbols you will touch (or { diff: "HEAD" } after editing) to see which units and routes may be affected.
- A description whose summary starts with "Stale:" may not match the code; read the code itself for that unit.
- Results reflect files on disk, including your own saved edits. Lists stop at ${MAX_RESULTS} items and say what was left out.`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const depth = (max: number) => z.number().int().min(1).max(max).optional();

/**
 * Sift as an MCP server (phase-2-design §5): read-only tools over a workspace, and each described
 * file as a `sift://file/<path>` resource. No tool changes code.
 */
export function createMcpServer(options: McpOptions): McpServer {
  const { workspace } = options;
  const server = new McpServer({ name: "sift", version: options.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "sift_describe",
    {
      title: "Describe a unit or file",
      description:
        "What a function, method, or whole file does, in plain language: summary, inputs, returns, nested steps with the units and library calls each step makes, effects (db.write, net.request, …), warnings, and whether the description is current. Target: a file path (src/a.ts), file#Symbol, Class.method, a unique name, or a unit ID (u_…).",
      inputSchema: { target: z.string().min(1).describe("File path, file#Symbol, Class.method, name, or u_ unit ID") },
      annotations: { title: "Describe", ...READ_ONLY },
    },
    tool(async ({ target }) => {
      const { file, symbol, id } = await resolveTarget(workspace, target);
      const logic = await workspace.logicFile(file);
      if (!logic.sift) throw noDescription(file);
      const picked = logic.units.filter((u) => (id ? u.unit.id === id : symbol === undefined || u.unit.symbol === symbol));
      if (picked.length === 0) {
        if (symbol !== undefined && logic.undescribed.includes(symbol)) throw noDescription(file, symbol);
        throw new SiftError("SOURCE_NOT_FOUND", `No unit named "${symbol ?? id}" in ${file}.`, logic.units.map((u) => `available: ${u.unit.symbol}`));
      }
      const names = await unitNames(workspace);
      const truncated: Truncated = {};
      const units = cap(picked, "units", truncated).map((u) => unitView(u, names));
      const undescribed = symbol === undefined && id === undefined ? cap(logic.undescribed, "undescribed", truncated) : [];
      const text = [
        symbol === undefined && id === undefined ? `${file} · ${logic.units.length} described unit${logic.units.length === 1 ? "" : "s"}` : null,
        ...units.map(renderUnit),
        undescribed.length > 0 ? `Not described yet: ${undescribed.join(", ")}` : null,
        ...truncationNote(truncated),
      ].filter((l): l is string => l !== null);
      return result(text.join("\n\n"), { file, units, ...(undescribed.length > 0 ? { undescribed } : {}), ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_find",
    {
      title: "Find units by name",
      description: "Units whose name matches: an exact name or Class.method first, else any name containing the query (case-insensitive). Each with file, kind, and one-line summary.",
      inputSchema: { query: z.string().min(1).describe("A name, Class.method, file#Symbol, or part of a name") },
      annotations: { title: "Find", ...READ_ONLY },
    },
    tool(async ({ query }) => {
      const graph = await workspace.graph();
      let ids = graph.find(query);
      if (ids.length === 0) {
        const q = query.toLowerCase();
        ids = graph.units().map((u) => u.id).filter((id) => id.slice(id.indexOf("#") + 1).toLowerCase().includes(q)).sort();
      }
      const truncated: Truncated = {};
      ids = cap(ids, "matches", truncated);
      const files = [...new Set(ids.filter((id) => graph.kindOf(id) === "unit").map(fileOf))];
      const logic = new Map((await workspace.logicFiles(files)).map((f) => [f.source, f]));
      const matches = ids.map((id) => {
        const kind = graph.unit(id)?.kind ?? graph.kindOf(id);
        const described = logic.get(fileOf(id))?.units.find((u) => u.ref === id);
        if (!described) return { ref: id, file: fileOf(id), kind, described: false as const };
        const stale = staleNote(described);
        return { ref: id, file: fileOf(id), kind, status: described.status, ...(stale ? { stale } : {}), summary: stale ? `${stale} ${described.unit.summary}` : described.unit.summary };
      });
      const text = matches.length === 0
        ? `No unit matches "${query}".`
        : [
            ...matches.map((m) => `${m.ref} · ${m.kind}${"summary" in m ? ` · ${m.status}\n  ${m.summary}` : graph.kindOf(m.ref) === "unit" ? " · not described yet" : " · declaration"}`),
            ...truncationNote(truncated),
          ].join("\n");
      return result(text, { matches, ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_callers",
    {
      title: "Callers",
      description: `Units and routes that call a symbol, up to depth levels up (default ${DEFAULT_DEPTH}), with edge confidence. possibleCallers lists unresolved calls with a matching name: when it is not empty, the list may be incomplete.`,
      inputSchema: { symbol: z.string().min(1).describe("file#Symbol, Class.method, or a unique name"), depth: depth(10) },
      annotations: { title: "Callers", ...READ_ONLY },
    },
    tool(async ({ symbol, depth }) => {
      const r = await workspace.callers(symbol, depth ?? DEFAULT_DEPTH);
      const graph = await workspace.graph();
      const truncated: Truncated = {};
      const callers = cap(r.callers, "callers", truncated).map((h) => hitView(graph, h));
      const possibleCallers = cap(r.possibleCallers, "possibleCallers", truncated).map(gapView);
      const text = [
        `Callers of ${r.subject}`,
        ...(callers.length === 0 ? ["  (none found)"] : hitTree(callers, r.subject)),
        ...gapLines("May be incomplete: unresolved calls with a matching name:", possibleCallers),
        ...truncationNote(truncated),
      ];
      return result(text.join("\n"), { subject: r.subject, callers, possibleCallers, ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_callees",
    {
      title: "Callees",
      description: `Units and library calls a symbol makes, up to depth levels down (default ${DEFAULT_DEPTH}), with the effects of each and of the subject as a whole. unresolved lists calls Sift could not follow.`,
      inputSchema: { symbol: z.string().min(1).describe("file#Symbol, Class.method, or a unique name"), depth: depth(10) },
      annotations: { title: "Callees", ...READ_ONLY },
    },
    tool(async ({ symbol, depth }) => {
      const r = await workspace.callees(symbol, depth ?? DEFAULT_DEPTH);
      const graph = await workspace.graph();
      const truncated: Truncated = {};
      const callees = cap(r.callees, "callees", truncated).map((h) => hitView(graph, h, true));
      const unresolved = cap(r.unresolved, "unresolved", truncated).map(gapView);
      const text = [
        `Calls made by ${r.subject}${r.effects.length > 0 ? `  [${r.effects.join(", ")}]` : ""}`,
        ...(callees.length === 0 ? ["  (none found)"] : hitTree(callees, r.subject)),
        ...gapLines("Not resolved (these calls may lead anywhere):", unresolved),
        ...truncationNote(truncated),
      ];
      return result(text.join("\n"), { subject: r.subject, effects: r.effects, callees, unresolved, ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_impact",
    {
      title: "Impact of a change",
      description:
        'What changing some symbols may affect: units that call them (nearest first) and routes whose handlers reach them, each with the weakest edge confidence on the path. Pass symbols, or diff: a git ref (e.g. "HEAD") to use every unit changed since it, including uncommitted edits.',
      inputSchema: {
        symbols: z.array(z.string().min(1)).optional().describe("file#Symbol, Class.method, or unique names"),
        diff: z.string().min(1).optional().describe('A git ref to diff the working tree against, e.g. "HEAD" or "main"'),
      },
      annotations: { title: "Impact", ...READ_ONLY },
    },
    tool(async ({ symbols, diff }) => {
      const r = await workspace.impact(symbols ?? [], diff);
      const truncated: Truncated = {};
      const subjects = cap(r.subjects, "subjects", truncated);
      const units = cap(r.units, "units", truncated).map((u) => ({ ref: u.id, depth: u.depth, confidence: u.confidence, path: u.path, via: u.via }));
      const routes = cap(r.routes, "routes", truncated).map((x) => ({ route: x.id.slice("route:".length), handler: x.handler, confidence: x.confidence }));
      const gaps = cap(r.gaps, "gaps", truncated).map(gapView);
      const text = subjects.length === 0
        ? [`No units changed since ${diff}.`, ...r.notes.map((n) => `  ${n}`)]
        : [
            `Impact of changing ${subjects.join(", ")}`,
            ...r.notes.map((n) => `  note: ${n}`),
            "Routes",
            ...(routes.length === 0 ? ["  (none)"] : routes.map((x) => `  ${x.route} · handled in ${x.handler} · ${x.confidence}`)),
            "Units",
            ...(units.length === 0 ? ["  (none)"] : units.map((u) => `  ${u.ref} · ${u.via.kind === "emits" ? `listens to ${u.via.event}` : "calls"} ${u.path[u.path.length - 2] ?? ""} · ${u.confidence}${u.depth > 1 ? ` · ${u.depth} levels up` : ""}`)),
            "Tests: not tracked yet.",
            ...gapLines("May be incomplete: calls or registrations Sift could not resolve:", gaps),
            ...truncationNote(truncated),
          ];
      return result(text.join("\n"), { subjects, units, routes, gaps, notes: r.notes, ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_flow",
    {
      title: "Flow of a route",
      description:
        'What an HTTP route does: its handler and every unit and library call reachable from it, nearest first, with effects at each step. Route: "POST /transfers", or a path for every method. Without a route, lists the routes.',
      inputSchema: { route: z.string().min(1).optional().describe('"METHOD /path" or "/path"'), depth: depth(20) },
      annotations: { title: "Flow", ...READ_ONLY },
    },
    tool(async ({ route, depth }) => {
      if (route === undefined) {
        const routes = (await workspace.graph()).routes().map((r) => r.slice("route:".length));
        return result(routes.length === 0 ? "No routes found." : ["Routes", ...routes.map((r) => `  ${r}`)].join("\n"), { routes });
      }
      const flows = await workspace.flow(route, depth ?? 10);
      const graph = await workspace.graph();
      const truncated: Truncated = {};
      const views = flows.map((f) => ({
        route: f.route.slice("route:".length),
        handlers: f.handlers.map((h) => ({ ref: h.id, ...(h.handlerKey ? { inlineCallback: h.handlerKey } : {}), effects: f.effects[h.id] ?? [] })),
        reaches: cap(f.hits, "reached", truncated).map((h) => ({ ...hitView(graph, h), effects: graph.kindOf(h.id) === "external" ? (h.via.effects ?? []) : (f.effects[h.id] ?? []) })),
      }));
      const text = views.flatMap((f) => [
        `Flow of ${f.route}`,
        ...(f.handlers.length === 0 ? ["  (no handler found)"] : []),
        ...f.handlers.flatMap((h) => [
          `  handled by ${h.ref}${h.inlineCallback ? ` (inline callback ${h.inlineCallback})` : ""}${h.effects.length > 0 ? `  [${h.effects.join(", ")}]` : ""}`,
          ...hitTree(f.reaches, h.ref, 2),
        ]),
      ]);
      return result([...text, ...truncationNote(truncated)].join("\n"), { flows: views, ...withTruncated(truncated) });
    }),
  );

  server.registerTool(
    "sift_status",
    {
      title: "Out-of-date descriptions",
      description: "Which descriptions no longer match the code: changed, new (undescribed), deleted, renamed, stale, and units whose callees' summaries changed. inSync is true when nothing needs regenerating.",
      inputSchema: { paths: z.array(z.string().min(1)).optional().describe("Limit to these files or folders") },
      annotations: { title: "Status", ...READ_ONLY },
    },
    tool(async ({ paths }) => {
      const r = await workspace.status(paths ? { paths: paths.map((p) => projectPath(workspace, p)) } : {});
      const truncated: Truncated = {};
      const lists = {
        changed: cap(r.changed, "changed", truncated),
        new: cap(r.new, "new", truncated),
        deleted: cap(r.deleted, "deleted", truncated),
        renamed: cap(r.renamed, "renamed", truncated),
        stale: cap(r.stale, "stale", truncated),
        contextChanged: cap(r.contextChanged, "contextChanged", truncated),
        unreadable: cap(r.unreadable, "unreadable", truncated),
      };
      const c = r.counts;
      const text = [
        r.inSync ? "In sync: every description matches the code." : "Out of date: run sift generate to update.",
        `${c.units} described units: ${c.generated} generated, ${c.userEdited} edited by a person, ${c.verified} verified.`,
        ...section("Code changed since described", lists.changed),
        ...section("Not described yet", lists.new),
        ...section("Code deleted", lists.deleted),
        ...section("Renamed or moved", lists.renamed.map((x) => `${x.from} → ${x.to} (${x.change})`)),
        ...section("Marked stale", lists.stale),
        ...section("Callees' summaries changed", lists.contextChanged),
        ...section("Unreadable .sift files", lists.unreadable),
        ...truncationNote(truncated),
      ];
      return result(text.join("\n"), { inSync: r.inSync, counts: r.counts, ...lists, ...withTruncated(truncated) });
    }),
  );

  if (options.allowGenerate) {
    server.registerTool(
      "sift_generate",
      {
        title: "Generate descriptions",
        description: "Describe new and changed code with AI and write the .sift files. Spends the user's AI quota; use dryRun first to see how much work it would be. Never changes source code.",
        inputSchema: {
          paths: z.array(z.string().min(1)).optional().describe("Files or folders; default the whole project"),
          force: z.boolean().optional().describe("Describe again even when the code is unchanged"),
          dryRun: z.boolean().optional().describe("Only report the AI work it would do"),
        },
        annotations: { title: "Generate", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      tool(async ({ paths, force, dryRun }) => {
        const r = await workspace.generate({ ...(paths ? { paths: paths.map((p) => projectPath(workspace, p)) } : {}), ...(force ? { force } : {}), ...(dryRun ? { dryRun } : {}) });
        const summary = {
          planned: r.planned.length,
          described: r.described.map((d) => ({ unit: d.unit, action: d.action, stale: d.stale, warnings: d.warnings })),
          failed: r.failed.map((f) => ({ unit: f.unit, reason: f.reason })),
          needsReview: r.needsReview,
          written: r.written,
          removed: r.removed,
          usage: r.usage,
        };
        const text = dryRun
          ? `Would run ${r.planned.length} AI task${r.planned.length === 1 ? "" : "s"}: ${r.planned.map((p) => p.unit).slice(0, MAX_RESULTS).join(", ") || "nothing to do"}.`
          : [
              `Described ${r.described.length} unit${r.described.length === 1 ? "" : "s"}; wrote ${r.written.length} .sift file${r.written.length === 1 ? "" : "s"}.`,
              ...r.failed.map((f) => `  failed: ${f.unit}: ${f.reason}`),
              ...r.needsReview.map((u) => `  review: ${u} (a person's wording was changed; marked stale)`),
            ].join("\n");
        return result(text, summary);
      }),
    );
  }

  server.registerResource(
    "sift-file",
    new ResourceTemplate("sift://file/{+path}", {
      list: async () => ({
        resources: (await listSiftFiles(workspace.root)).map((source) => ({ uri: `sift://file/${source}`, name: source, mimeType: "text/plain" })),
      }),
    }),
    { title: "Logic of a source file", description: "Sift's description of every unit in a source file, with status.", mimeType: "text/plain" },
    async (uri, { path }) => {
      const source = decodeURIComponent(Array.isArray(path) ? path.join("/") : path!);
      const logic = await workspace.logicFile(source);
      if (!logic.sift) throw noDescription(source);
      const names = await unitNames(workspace);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: renderFile(logic, names) }] };
    },
  );

  return server;
}

/** Run the MCP server on stdio streams until the input ends. */
export async function serveMcp(options: McpOptions & { input: Readable; output: Writable }): Promise<{ server: McpServer; closed: Promise<void> }> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(options.input, options.output);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      options.workspace.dispose();
      resolve();
    };
  });
  options.input.once("end", () => void server.close());
  await server.connect(transport);
  return { server, closed };
}

// ---------------------------------------------------------------------------------------------

type Handler<A> = (args: A) => Promise<CallToolResult>;

/** Sift's errors become tool errors the agent can read and act on, not protocol failures. */
function tool<A>(handler: Handler<A>): Handler<A> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof SiftError) return { isError: true, content: [{ type: "text", text: [err.message, ...err.details.map((d) => `  - ${d}`)].join("\n") }] };
      throw err;
    }
  };
}

function result(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

function withTruncated(truncated: Truncated): { truncated?: Truncated } {
  return Object.keys(truncated).length > 0 ? { truncated } : {};
}

function fileOf(id: string): string {
  return id.slice(0, id.indexOf("#"));
}

/** A path from the agent, which may be absolute, as a project path with forward slashes. */
function projectPath(workspace: Workspace, path: string): string {
  const rel = isAbsolute(path) ? relative(workspace.root, path) : path;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

const PATH_LIKE = /[\\/]|\.[cm]?[jt]sx?$/;

async function resolveTarget(workspace: Workspace, target: string): Promise<{ file: string; symbol?: string; id?: string }> {
  const t = target.trim();
  if (/^u_[a-z2-7]{8}$/.test(t)) {
    const { source, unit } = await workspace.unit(t);
    return { file: source, id: unit.id };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) return { file: projectPath(workspace, t.slice(0, hash)), symbol: t.slice(hash + 1) };
  if (PATH_LIKE.test(t)) return { file: projectPath(workspace, t) };
  const { source, unit } = await workspace.unit(t);
  return { file: source, symbol: unit.symbol };
}

function noDescription(file: string, symbol?: string): SiftError {
  return new SiftError("SOURCE_NOT_FOUND", `${symbol ? `${file}#${symbol}` : file} has no description yet. Run "sift generate ${file}" to create it.`);
}

/** Unit ID → `file#Symbol`, across every `.sift` file. */
async function unitNames(workspace: Workspace): Promise<Map<string, string>> {
  return new Map([...(await workspace.unitIndex())].map(([id, { source, unit }]) => [id, `${source}#${unit.symbol}`]));
}

function renderFile(logic: LogicFile, names: Map<string, string>): string {
  const units: UnitView[] = logic.units.map((u) => unitView(u, names));
  return [`${logic.source} · ${units.length} described unit${units.length === 1 ? "" : "s"}`, ...units.map(renderUnit), ...(logic.undescribed.length > 0 ? [`Not described yet: ${logic.undescribed.join(", ")}`] : [])].join("\n\n");
}

interface HitView {
  ref: string;
  kind: string;
  parent: string;
  depth: number;
  edge: string;
  confidence: string;
  dispatch?: string;
  event?: string;
  /** The file and lines of the call sites. */
  at: string;
  effects?: string[];
}

function hitView(graph: CodeGraph, hit: QueryHit, withEffects = false): HitView {
  const kind = graph.kindOf(hit.id);
  const lines = [...new Set(hit.via.sites.map((s) => s.range.start.line))].sort((a, b) => a - b);
  const effects = withEffects ? (kind === "external" ? (hit.via.effects ?? []) : graph.effectsOf(hit.id, { propagated: true })) : [];
  return {
    ref: hit.id,
    kind,
    parent: hit.parent,
    depth: hit.depth,
    edge: hit.via.kind,
    confidence: hit.via.confidence,
    ...(hit.via.dispatch ? { dispatch: hit.via.dispatch } : {}),
    ...(hit.via.event ? { event: hit.via.event } : {}),
    at: `${hit.via.file}:${lines.join(",")}`,
    ...(effects.length > 0 ? { effects } : {}),
  };
}

/** Hits as an indented tree under `root`, with how each was reached. */
function hitTree(hits: HitView[], root: string, indent = 1): string[] {
  const out: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const h of hits.filter((x) => x.parent === parent && x.depth === depth)) {
      const name = h.kind === "external" ? h.ref.slice(4).replace("#", ": ") : h.ref;
      const how = [h.edge, h.dispatch ? `via ${h.dispatch}` : null, h.event ? `via ${h.event}` : null, h.confidence].filter(Boolean).join(" · ");
      const effects = h.effects && h.effects.length > 0 ? `  [${h.effects.join(", ")}]` : "";
      out.push(`${"  ".repeat(indent + depth - 1)}${name}${h.kind === "declaration" ? " (declaration)" : ""} · ${how} · ${h.at}${effects}`);
      walk(h.ref, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

function gapView(g: GapNote): { kind: string; unit: string; expression: string; at: string } {
  return { kind: g.kind, unit: g.unit, expression: g.expression.replace(/\s+/g, " ").slice(0, 120), at: `${g.file}:${g.site.range.start.line}` };
}

function gapLines(title: string, gaps: ReturnType<typeof gapView>[]): string[] {
  return gaps.length === 0 ? [] : [title, ...gaps.map((g) => `  ${g.kind}: ${g.expression}  ${g.at} (in ${g.unit})`)];
}

function section(title: string, items: string[]): string[] {
  return items.length === 0 ? [] : [`${title}:`, ...items.map((i) => `  ${i}`)];
}
