import { describe, expect, it, vi } from "vitest";

import { Wesh } from "./index";
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from "./mocks/InMemoryFileSystem";
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from "./utils/test-stream";
import type { WeshCommandFunction } from "./types";

function createWesh() {
  return new Wesh({
    rootHandle: new MockFileSystemDirectoryHandle({ name: "root" }) as unknown as FileSystemDirectoryHandle,
  });
}

async function execute({ wesh, script }: { wesh: Wesh, script: string }) {
  const stdout = createTestWriteCaptureHandle();
  const stderr = createTestWriteCaptureHandle();
  const result = await wesh.execute({
    source: createTextShellSource({ text: script }),
    stdin: createTestReadHandleFromText({ text: "" }),
    stdout: stdout.handle,
    stderr: stderr.handle,
  });
  return { result, stdout: stdout.text, stderr: stderr.text };
}

describe("Wesh lazy command loading", () => {
  it("keeps metadata available without loading the implementation and caches demand loads", async () => {
    const wesh = createWesh();
    await wesh.init();
    const command: WeshCommandFunction = async ({ context }) => {
      await context.text().print({ text: "lazy-loaded\\n" });
      return { exitCode: 0 };
    };
    const load = vi.fn(async () => command);
    wesh.registerCommand({
      definition: {
        meta: { name: "lazy-test", description: "Lazy test command", usage: "lazy-test" },
        load,
      },
    });

    expect(wesh.listCommands()).toContainEqual({
      name: "lazy-test",
      kind: "builtin",
      description: "Lazy test command",
      usage: "lazy-test",
    });
    expect(load).not.toHaveBeenCalled();

    const first = await execute({ wesh, script: "lazy-test" });
    const second = await execute({ wesh, script: "lazy-test" });
    expect(first.stdout).toBe("lazy-loaded\\n");
    expect(second.stdout).toBe("lazy-loaded\\n");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resolves command metadata without loading the target implementation", async () => {
    const wesh = createWesh();
    await wesh.init();
    const command: WeshCommandFunction = async () => ({ exitCode: 0 });
    const load = vi.fn(async () => command);
    wesh.registerCommand({
      definition: {
        meta: { name: "lazy-meta", description: "Lazy metadata command", usage: "lazy-meta" },
        load,
      },
    });

    const lookup = await execute({ wesh, script: "command -v lazy-meta" });
    const help = await execute({ wesh, script: "help lazy-meta" });

    expect(lookup.stdout).toBe("lazy-meta\n");
    expect(help.stdout).toContain("Lazy metadata command");
    expect(load).not.toHaveBeenCalled();

    await execute({ wesh, script: "lazy-meta" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load across concurrent command demand", async () => {
    const wesh = createWesh();
    await wesh.init();
    let resolveLoad: ((command: WeshCommandFunction) => void) | undefined;
    let resolveLoadStarted: (() => void) | undefined;
    const loadStarted = new Promise<void>(resolve => {
      resolveLoadStarted = resolve;
    });
    const load = vi.fn(() => {
      resolveLoadStarted?.();
      return new Promise<WeshCommandFunction>(resolve => {
        resolveLoad = resolve;
      });
    });
    wesh.registerCommand({
      definition: {
        meta: { name: "lazy-race", description: "Lazy race command", usage: "lazy-race" },
        load,
      },
    });

    const first = execute({ wesh, script: "lazy-race" });
    const second = execute({ wesh, script: "lazy-race" });
    await loadStarted;
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad?.(async () => ({ exitCode: 0 }));
    await expect(first).resolves.toMatchObject({ result: { exitCode: 0 } });
    await expect(second).resolves.toMatchObject({ result: { exitCode: 0 } });
  });

  it("preserves foreground interrupts while a command implementation is loading", async () => {
    const wesh = createWesh();
    await wesh.init();
    let resolveLoad: ((command: WeshCommandFunction) => void) | undefined;
    let resolveLoadStarted: (() => void) | undefined;
    const loadStarted = new Promise<void>(resolve => {
      resolveLoadStarted = resolve;
    });
    const command = vi.fn<WeshCommandFunction>(async ({ context }) => {
      await context.text().print({ text: "should-not-run\n" });
      return { exitCode: 0 };
    });
    wesh.registerCommand({
      definition: {
        meta: {
          name: "lazy-interrupt",
          description: "Lazy interrupt command",
          usage: "lazy-interrupt",
        },
        load: () => {
          resolveLoadStarted?.();
          return new Promise<WeshCommandFunction>(resolve => {
            resolveLoad = resolve;
          });
        },
      },
    });

    const execution = execute({ wesh, script: "lazy-interrupt" });
    await loadStarted;

    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);
    resolveLoad?.(command);

    await expect(execution).resolves.toMatchObject({
      result: {
        exitCode: 130,
        waitStatus: { kind: "signaled", signal: 2 },
      },
      stdout: "",
    });
    expect(command).not.toHaveBeenCalled();
  });


  it("reaps the command process when implementation loading fails", async () => {
    const wesh = createWesh();
    await wesh.init();
    const initialProcessCount = wesh.kernel.getProcesses().length;
    const load = vi.fn(async (): Promise<WeshCommandFunction> => {
      throw new Error("lazy-load-failed");
    });
    wesh.registerCommand({
      definition: {
        meta: {
          name: "lazy-load-failure",
          description: "Lazy load failure command",
          usage: "lazy-load-failure",
        },
        load,
      },
    });

    const first = await execute({ wesh, script: "lazy-load-failure" });
    expect(first.result.exitCode).toBe(1);
    expect(first.stderr).toBe("wesh: lazy-load-failed\n");
    expect(wesh.kernel.getProcesses()).toHaveLength(initialProcessCount);

    const second = await execute({ wesh, script: "lazy-load-failure" });
    expect(second.result.exitCode).toBe(1);
    expect(second.stderr).toBe("wesh: lazy-load-failed\n");
    expect(wesh.kernel.getProcesses()).toHaveLength(initialProcessCount);
    expect(load).toHaveBeenCalledTimes(1);
  });

});
