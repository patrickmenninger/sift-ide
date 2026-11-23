import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter, type CancellationToken, type MessageConnection } from "vscode-jsonrpc/node";
import { SiftError, type SiftErrorCode } from "@sift/core";
import { PROTOCOL_VERSION, type Notifications, type RequestMethod, type Requests, type SiftErrorData } from "./protocol.js";

/**
 * A typed client for `sift serve`. The extension spawns the server and passes its stdout and
 * stdin; tests pass in-memory streams. Sift errors come back as `SiftError` with their code.
 */
export class SiftClient {
  readonly connection: MessageConnection;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.connection = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output));
    this.connection.listen();
  }

  /** Check the protocol version and return the project root. */
  initialize(): Promise<Requests["sift/initialize"]["result"]> {
    return this.request("sift/initialize", { protocolVersion: PROTOCOL_VERSION });
  }

  /** A `token` lets the caller cancel the request; `sift/generate` then stops and reports `cancelled`. */
  async request<M extends RequestMethod>(method: M, params: Requests[M]["params"], token?: CancellationToken): Promise<Requests[M]["result"]> {
    try {
      const pending = token ? this.connection.sendRequest(method, params, token) : this.connection.sendRequest(method, params);
      return (await pending) as Requests[M]["result"];
    } catch (err) {
      if (err instanceof ResponseError && err.data && typeof (err.data as SiftErrorData).code === "string") {
        const data = err.data as SiftErrorData;
        throw new SiftError(data.code as SiftErrorCode, err.message, data.details);
      }
      throw err;
    }
  }

  on<N extends keyof Notifications>(method: N, listener: (params: Notifications[N]) => void): { dispose(): void } {
    return this.connection.onNotification(method, listener as (params: unknown) => void);
  }

  dispose(): void {
    this.connection.dispose();
  }
}
