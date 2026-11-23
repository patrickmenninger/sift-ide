import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { FakeProvider, Workspace } from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { serve } from "@sift/server";
import { builtinRulesDir } from "../../cli/src/program.js";
import { answer, fixtureCopy } from "../../cli/src/test-helpers.js";
import type { ServerChild } from "./server-process.js";

export { answer, fixtureCopy };

/** A child-process stand-in running `sift serve` in this process over in-memory pipes. Not shipped. */
export class FakeChild extends EventEmitter implements ServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exited = false;

  /** Simulate the process ending (a crash when nobody asked it to stop). */
  exit(code: number | null = 1): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    // Like a real process: "exit" comes after the streams have been flushed.
    setImmediate(() => this.emit("exit", code, null));
  }

  kill(): void {
    this.exit(null);
  }
}

/** Launch function for ServerProcess: each call opens the workspace and serves it on a new FakeChild. */
export function inProcessServer(dir: string, provider = new FakeProvider((req) => answer(req))) {
  const children: FakeChild[] = [];
  const launch = (): ServerChild => {
    const child = new FakeChild();
    children.push(child);
    void Workspace.open({ cwd: dir, adapters: [typescriptAdapter], builtinRulesDir: builtinRulesDir(), provider }).then(
      (workspace) => {
        const { closed } = serve({ workspace, input: child.stdin, output: child.stdout, serverVersion: "test" });
        void closed.then(() => child.exit(0));
      },
      (err: unknown) => {
        child.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        child.exit(1);
      },
    );
    return child;
  };
  return { launch, children, provider };
}
