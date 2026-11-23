import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceChange } from "@sift/core";
import { ServerProcess, type ServerState } from "./server-process.js";
import { fixtureCopy, inProcessServer } from "./test-support.js";

const waitFor = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("ServerProcess", () => {
  it("starts, answers requests, restarts after a crash with listeners kept, and stops", async () => {
    const dir = await fixtureCopy();
    const server = inProcessServer(dir);
    const states: ServerState["kind"][] = [];
    const log: string[] = [];
    const process = new ServerProcess({ root: dir, launch: server.launch, log: (l) => log.push(l), backoffMs: () => 0 });
    process.onDidChangeState((s) => states.push(s.kind));
    const changes: WorkspaceChange[] = [];
    process.on("sift/didChange", (c) => changes.push(c));

    // A request starts the server on demand.
    const status = await process.request("sift/status", {});
    expect(status.new.length).toBeGreaterThan(0);
    expect(process.state).toEqual({ kind: "running", serverVersion: "test" });
    expect(process.info?.provider).toEqual({ id: "claude-code", local: true });
    expect(states).toEqual(["starting", "running"]);

    // A crash: the server comes back, and notifications still arrive.
    server.children[0]!.exit(1);
    await waitFor(() => server.children.length === 2 && process.state.kind === "running");
    expect(log.some((l) => l.includes("exited unexpectedly"))).toBe(true);
    await writeFile(join(dir, "src/new-file.ts"), "export function added(): number {\n  return 1;\n}\n");
    await process.request("sift/refresh", {});
    await waitFor(() => changes.some((c) => c.type === "source" && c.files.includes("src/new-file.ts")));

    await process.stop();
    expect(process.state.kind).toBe("stopped");
    expect(server.children[1]!.listenerCount("exit")).toBe(0);
  }, 90_000);

  it("gives up after too many crashes in a short while", async () => {
    const dir = await fixtureCopy();
    const server = inProcessServer(dir);
    const process = new ServerProcess({ root: dir, launch: server.launch, log: () => {}, backoffMs: () => 0, restarts: { max: 2, windowMs: 60_000 } });
    await process.start();
    for (let i = 0; i < 3; i++) {
      await waitFor(() => process.state.kind === "running");
      server.children.at(-1)!.exit(1);
      await waitFor(() => process.state.kind !== "running");
    }
    await waitFor(() => process.state.kind === "failed");
    expect(server.children).toHaveLength(3);
    await expect(process.request("sift/status", {})).rejects.toThrow(/stopped 3 times/);
    // Restart (the command) starts again from a clean slate.
    await process.restart();
    expect(process.state.kind).toBe("running");
    await process.stop();
  }, 90_000);

  it("fails with the server's own explanation when it cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sift-noconfig-"));
    const server = inProcessServer(dir);
    const process = new ServerProcess({ root: dir, launch: server.launch, log: () => {} });
    await expect(process.start()).rejects.toThrow(/sift\.config\.yaml/);
    expect(process.state.kind).toBe("failed");
    // No restart loop for a server that never started.
    await new Promise((r) => setTimeout(r, 100));
    expect(server.children).toHaveLength(1);
  });

  it("fails when the launch itself throws", async () => {
    const process = new ServerProcess({
      root: "/nowhere",
      launch: () => {
        throw new Error("spawn ENOENT");
      },
      log: () => {},
    });
    await expect(process.start()).rejects.toThrow(/Could not start the Sift server: spawn ENOENT/);
  });
});
