import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter, type CancellationToken, type MessageConnection } from "vscode-jsonrpc/node";
import { SiftError, type Workspace } from "@sift/core";
import { PROTOCOL_VERSION, SIFT_ERROR, type Notifications, type RequestMethod, type Requests, type SiftErrorData } from "./protocol.js";

type Handlers = { [M in RequestMethod]: (params: Requests[M]["params"], token: CancellationToken) => Promise<Requests[M]["result"]> };

export interface ServeOptions {
  workspace: Workspace;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Reported by `sift/initialize`. */
  serverVersion: string;
}

/**
 * Serve a workspace over JSON-RPC until the input ends (phase-2-design §4.1). Returns the
 * connection, and a promise that settles when it closes.
 */
export function serve(options: ServeOptions): { connection: MessageConnection; closed: Promise<void> } {
  const { workspace } = options;
  const connection = createMessageConnection(new StreamMessageReader(options.input), new StreamMessageWriter(options.output));
  const notify = <N extends keyof Notifications>(method: N, params: Notifications[N]) => void connection.sendNotification(method, params);
  let initialized = false;

  const handlers: Handlers = {
    "sift/initialize": async ({ protocolVersion }) => {
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw new SiftError("NOT_IMPLEMENTED", `This Sift server speaks protocol ${PROTOCOL_VERSION}, but the client speaks ${protocolVersion}. Update the extension or Sift so they match.`);
      }
      initialized = true;
      const provider = workspace.provider ? { id: workspace.provider.id, local: workspace.provider.capabilities.local } : null;
      return { protocolVersion: PROTOCOL_VERSION, root: workspace.root, serverVersion: options.serverVersion, provider };
    },
    "sift/refresh": async ({ fullHash }) => {
      const r = await workspace.refresh(fullHash === undefined ? {} : { fullHash });
      return { rebuilt: r.rebuilt, removed: r.removed };
    },
    "sift/logicFile": ({ source }) => workspace.logicFile(source),
    "sift/unit": ({ query }) => workspace.unit(query),
    "sift/extraction": ({ source }) => workspace.extraction(source),
    "sift/status": (p) => workspace.status(p),
    "sift/callers": ({ query, depth }) => workspace.callers(query, depth),
    "sift/callees": ({ query, depth }) => workspace.callees(query, depth),
    "sift/impact": ({ queries, diff }) => workspace.impact(queries, diff),
    "sift/routes": async () => (await workspace.graph()).routes(),
    "sift/flow": ({ route, depth }) => workspace.flow(route, depth),
    "sift/sourceRanges": ({ unit, step }) => workspace.sourceRanges(unit, step),
    "sift/stepAt": ({ source, position }) => workspace.stepAt(source, position),
    "sift/stepTargets": ({ unit, step }) => workspace.stepTargets(unit, step),
    // Cancelling the request ($/cancelRequest) stops the run; the report then says `cancelled`.
    "sift/generate": async ({ token, ...rest }, cancel) => {
      const controller = new AbortController();
      const subscription = cancel.onCancellationRequested(() => controller.abort());
      try {
        return await workspace.generate({
          ...rest,
          signal: controller.signal,
          ...(token !== undefined ? { onEvent: (event) => notify("sift/generateProgress", { token, event }) } : {}),
        });
      } finally {
        subscription.dispose();
      }
    },
    "sift/verify": ({ targets }) => workspace.verify(targets),
    "sift/edit/create": (p) => workspace.edits.create(p),
    "sift/edit/update": ({ id, ...change }) => workspace.edits.update(id, change),
    "sift/edit/get": ({ id }) => workspace.edits.get(id),
    "sift/edit/list": (p) => workspace.edits.list(p),
    "sift/edit/propose": async ({ id, token }, cancel) => {
      const controller = new AbortController();
      const subscription = cancel.onCancellationRequested(() => controller.abort());
      try {
        return await workspace.edits.propose(id, {
          signal: controller.signal,
          ...(token !== undefined ? { onEvent: (event) => notify("sift/editProgress", { token, event }) } : {}),
        });
      } finally {
        subscription.dispose();
      }
    },
    "sift/edit/answer": ({ id, answers }) => workspace.edits.answer(id, answers),
    "sift/edit/runChecks": async ({ id }, cancel) => {
      const controller = new AbortController();
      const subscription = cancel.onCancellationRequested(() => controller.abort());
      try {
        return await workspace.edits.runChecks(id, { signal: controller.signal });
      } finally {
        subscription.dispose();
      }
    },
    "sift/edit/apply": ({ id, ...options }) => workspace.edits.apply(id, options),
    "sift/edit/reject": ({ id }) => workspace.edits.reject(id),
    "sift/edit/rebase": ({ id }) => workspace.edits.rebase(id),
    "sift/edit/undo": ({ id }) => workspace.edits.undo(id),
  };

  for (const [method, handler] of Object.entries(handlers) as [RequestMethod, (p: unknown, token: CancellationToken) => Promise<unknown>][]) {
    connection.onRequest(method, async (params: unknown, token: CancellationToken) => {
      if (!initialized && method !== "sift/initialize") throw new ResponseError(SIFT_ERROR, 'Call "sift/initialize" first.', { code: "NOT_IMPLEMENTED", details: [] } satisfies SiftErrorData);
      try {
        return await handler(params ?? {}, token);
      } catch (err) {
        throw toResponseError(err);
      }
    });
  }

  const subscription = workspace.onDidChange((change) => notify("sift/didChange", change));
  const closed = new Promise<void>((resolve) => {
    connection.onClose(() => {
      subscription.dispose();
      workspace.dispose();
      resolve();
    });
  });
  connection.listen();
  return { connection, closed };
}

function toResponseError(err: unknown): ResponseError<SiftErrorData> {
  if (err instanceof ResponseError) return err as ResponseError<SiftErrorData>;
  if (err instanceof SiftError) return new ResponseError(SIFT_ERROR, err.message, { code: err.code, details: err.details });
  const message = err instanceof Error ? err.message : String(err);
  return new ResponseError(SIFT_ERROR, `Unexpected error: ${message}`, { code: "UNEXPECTED", details: err instanceof Error && err.stack ? [err.stack] : [] });
}
