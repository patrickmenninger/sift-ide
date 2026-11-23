import type { Readable, Writable } from "node:stream";
import { SiftClient, type Notifications, type RequestMethod, type Requests } from "@sift/server";
import type { CancellationToken } from "vscode-jsonrpc/node";

/** What the extension needs from a spawned `sift serve`: tests pass in-memory streams. */
export interface ServerChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(): unknown;
}

export type ServerState =
  | { kind: "starting" }
  | { kind: "running"; serverVersion: string }
  | { kind: "stopped" }
  /** Gave up: the server could not start, or crashed too often. `message` is fit to show. */
  | { kind: "failed"; message: string };

export interface ServerProcessOptions {
  /** The project root (the folder holding sift.config.yaml). */
  root: string;
  launch: () => ServerChild;
  /** Server stderr and lifecycle notes, one line at a time (the Sift output channel). */
  log: (line: string) => void;
  /** Crashes tolerated within `windowMs` before giving up. Default: 3 within 3 minutes. */
  restarts?: { max: number; windowMs: number };
  /** Delay before restart attempt n (1-based). Default: n seconds. */
  backoffMs?: (attempt: number) => number;
  now?: () => number;
}

type Listener<N extends keyof Notifications> = (params: Notifications[N]) => void;

/**
 * One `sift serve` child process per project (phase-2-design §3): starts it, checks the
 * protocol version, restarts it after a crash (a few times, with backoff), and stops it.
 * Notification listeners stay attached across restarts.
 */
export class ServerProcess {
  private stateValue: ServerState = { kind: "stopped" };
  private infoValue: Requests["sift/initialize"]["result"] | null = null;
  private child: ServerChild | null = null;
  private client: SiftClient | null = null;
  private ready: Promise<SiftClient> | null = null;
  private stopping = false;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateListeners = new Set<(state: ServerState) => void>();
  private readonly notificationListeners = new Map<keyof Notifications, Set<Listener<keyof Notifications>>>();

  constructor(private readonly options: ServerProcessOptions) {}

  get state(): ServerState {
    return this.stateValue;
  }

  /** What the running server reported at `sift/initialize`. */
  get info(): Requests["sift/initialize"]["result"] | null {
    return this.infoValue;
  }

  get root(): string {
    return this.options.root;
  }

  onDidChangeState(listener: (state: ServerState) => void): { dispose(): void } {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  on<N extends keyof Notifications>(method: N, listener: Listener<N>): { dispose(): void } {
    let set = this.notificationListeners.get(method);
    if (!set) this.notificationListeners.set(method, (set = new Set()));
    set.add(listener as Listener<keyof Notifications>);
    return { dispose: () => set.delete(listener as Listener<keyof Notifications>) };
  }

  /** Start the server, or return the running one. Resolves once `sift/initialize` succeeded. */
  start(): Promise<SiftClient> {
    if (this.ready && this.stateValue.kind !== "failed" && this.stateValue.kind !== "stopped") return this.ready;
    this.stopping = false;
    this.ready = this.launch();
    // Callers that only start the server must not see an unhandled rejection; `request` reports failures.
    this.ready.catch(() => {});
    return this.ready;
  }

  /** Send a request, starting the server first if needed. */
  async request<M extends RequestMethod>(method: M, params: Requests[M]["params"], token?: CancellationToken): Promise<Requests[M]["result"]> {
    if (this.stateValue.kind === "failed") throw new Error(this.stateValue.message);
    const client = this.stateValue.kind === "running" && this.client ? this.client : await this.start();
    return client.request(method, params, token);
  }

  /** Stop and start again, forgetting earlier crashes (the "Restart Server" command). */
  async restart(): Promise<SiftClient> {
    await this.stop();
    this.crashes = [];
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.client?.dispose();
    this.client = null;
    this.child = null;
    this.ready = null;
    if (child) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      // Closing stdin ends `sift serve` cleanly; kill it if it does not exit soon.
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(timer);
    }
    this.setState({ kind: "stopped" });
  }

  dispose(): void {
    void this.stop();
    this.stateListeners.clear();
    this.notificationListeners.clear();
  }

  private async launch(): Promise<SiftClient> {
    this.setState({ kind: "starting" });
    let child: ServerChild;
    try {
      child = this.options.launch();
    } catch (err) {
      return this.fail(`Could not start the Sift server: ${messageOf(err)}`);
    }
    this.child = child;
    let stderrTail: string[] = [];
    readLines(child.stderr, (line) => {
      stderrTail = [...stderrTail.slice(-19), line];
      this.options.log(line);
    });
    const client = new SiftClient(child.stdout, child.stdin);
    this.client = client;
    for (const [method, listeners] of this.notificationListeners) {
      client.on(method, (params) => listeners.forEach((l) => l(params)));
    }
    let initialized = false;
    const exited = new Promise<string>((resolve) =>
      child.once("exit", (code, signal) => {
        resolve(`The Sift server exited (${signal ?? `code ${code}`}) before it was ready.${stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : ""}`);
        if (initialized) this.onExit(child, code, signal);
      }),
    );
    try {
      const info = await Promise.race([client.initialize(), exited.then((m) => Promise.reject(new Error(m)))]);
      initialized = true;
      this.infoValue = info;
      this.options.log(`Sift server ${info.serverVersion} running for ${info.root}`);
      this.setState({ kind: "running", serverVersion: info.serverVersion });
      return client;
    } catch (err) {
      client.dispose();
      child.kill();
      if (this.child === child) this.child = null;
      // Errors before initialize (bad config, protocol mismatch) do not go away by restarting.
      return this.fail(messageOf(err));
    }
  }

  private onExit(child: ServerChild, code: number | null, signal: string | null): void {
    if (this.stopping || this.child !== child) return;
    this.client?.dispose();
    this.client = null;
    this.child = null;
    const now = (this.options.now ?? Date.now)();
    const { max, windowMs } = this.options.restarts ?? { max: 3, windowMs: 180_000 };
    this.crashes = [...this.crashes.filter((t) => now - t < windowMs), now];
    this.options.log(`Sift server exited unexpectedly (${signal ?? `code ${code}`}).`);
    if (this.crashes.length > max) {
      this.ready = null;
      this.setState({ kind: "failed", message: `The Sift server stopped ${this.crashes.length} times in a short while, so it was not restarted. See the Sift output for details.` });
      return;
    }
    const delay = (this.options.backoffMs ?? ((n) => n * 1000))(this.crashes.length);
    this.options.log(`Restarting in ${Math.round(delay / 100) / 10}s…`);
    this.setState({ kind: "starting" });
    let resolveReady!: (c: SiftClient) => void;
    let rejectReady!: (e: unknown) => void;
    this.ready = new Promise<SiftClient>((res, rej) => ((resolveReady = res), (rejectReady = rej)));
    this.ready.catch(() => {});
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.launch().then(resolveReady, rejectReady);
    }, delay);
  }

  private fail(message: string): never {
    this.options.log(message);
    this.setState({ kind: "failed", message });
    throw new Error(message);
  }

  private setState(state: ServerState): void {
    this.stateValue = state;
    for (const l of this.stateListeners) l(state);
  }
}

function readLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.length > 0) onLine(line);
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer);
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
