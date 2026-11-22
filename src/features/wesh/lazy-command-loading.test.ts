import { describe, expect, it, vi } from "vitest";

import { printfCommandDefinition } from "./commands/printf/definition";
import { Wesh } from "./index";
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from "./mocks/InMemoryFileSystem";
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from "./utils/test-stream";
import type { WeshCommandFunction } from "./types";

const conditionalLoad = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  resume: Promise.withResolvers<void>(),
}));

vi.mock(import('./shell/conditional'), async importOriginal => {
  conditionalLoad.started.resolve();
  await conditionalLoad.resume.promise;
  return importOriginal();
});

function createWesh() {
  return new Wesh({
    rootHandle: new MockFileSystemDirectoryHandle({ name: "root" }) as unknown as FileSystemDirectoryHandle,
  });
}

function createWeshWithBashDefinition() {
  using registration = vi.spyOn(Wesh.prototype, "registerCommand");
  const wesh = createWesh();
  const bash = registration.mock.calls.find(([{ definition }]) => definition.meta.name === "bash")?.[0].definition;
  if (bash === undefined) {
    throw new Error("Expected Wesh to register Bash");
  }
  return { wesh, bash };
}

async function execute({ wesh, script, signal }: { wesh: Wesh, script: string, signal?: AbortSignal }) {
  const stdout = createTestWriteCaptureHandle();
  const stderr = createTestWriteCaptureHandle();
  const result = await wesh.execute({
    source: createTextShellSource({ text: script }),
    stdin: createTestReadHandleFromText({ text: "" }),
    stdout: stdout.handle,
    stderr: stderr.handle,
    signal,
  });
  return { result, stdout: stdout.text, stderr: stderr.text };
}

describe("Wesh lazy command loading", () => {
  it('stops a conditional while its evaluator is still loading and evaluates a later input', async () => {
    const wesh = createWesh();
    await wesh.init();
    const controller = new AbortController();
    using _release = {
      [Symbol.dispose]() {
        conditionalLoad.resume.resolve();
      },
    };

    const input = execute({ wesh, script: '[[ "$((ran=1))" -eq 1 ]]; printf late', signal: controller.signal });
    await conditionalLoad.started.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });

    await expect.poll(() => Promise.race([input, undefined])).toMatchObject({
      result: { exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } },
      stdout: '',
      stderr: '',
    });
    conditionalLoad.resume.resolve();
    await expect(execute({ wesh, script: '[[ -z "$ran" ]] && printf recovered' })).resolves.toMatchObject({
      result: { exitCode: 0 },
      stdout: 'recovered',
      stderr: '',
    });
  });

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

  it.each(["lazy-interrupt", "exec lazy-interrupt"])("ends %s before its implementation finishes loading", async (script) => {
    const wesh = createWesh();
    await wesh.init();
    const load = Promise.withResolvers<WeshCommandFunction>();
    const started = Promise.withResolvers<void>();
    const command = vi.fn<WeshCommandFunction>(async ({ context }) => {
      await context.text().print({ text: "should-not-run\n" });
      return { exitCode: 0 };
    });
    using _release = {
      [Symbol.dispose]() {
        load.resolve(command);
      },
    };
    wesh.registerCommand({
      definition: {
        meta: {
          name: "lazy-interrupt",
          description: "Lazy interrupt command",
          usage: "lazy-interrupt",
        },
        load: () => {
          started.resolve();
          return load.promise;
        },
      },
    });

    const execution = execute({ wesh, script });
    await started.promise;

    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);
    await expect.poll(() => Promise.race([execution, undefined])).toMatchObject({
      result: {
        exitCode: 130,
        waitStatus: { kind: "signaled", signal: 2 },
      },
      stdout: "",
    });
    expect(command).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "Stop", signal: 2, exitCode: 130 },
    { mode: "SIGTERM", signal: 15, exitCode: 143 },
  ])("interrupts the registered Bash load with $mode and shares it with a later call", async ({ mode, signal, exitCode }) => {
    const { wesh, bash } = createWeshWithBashDefinition();
    await wesh.init();
    const initialProcesses = wesh.kernel.getProcesses();
    const loadBash = bash.load;
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const implementation = vi.fn<WeshCommandFunction>();
    using load = vi.spyOn(bash, "load").mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      implementation.mockImplementation(await loadBash());
      return implementation;
    });
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };

    const controller = new AbortController();
    const interrupted = execute({
      wesh,
      script: "/bin/bash -c 'printf should-not-run'",
      signal: controller.signal,
    });
    await started.promise;
    if (mode === "Stop") {
      controller.abort();
      await wesh.interruptForeground({ foregroundSignal: controller.signal });
    } else {
      const child = wesh.kernel.getProcesses().find(({ args }) => args[0] === "/bin/bash" && args.includes("printf should-not-run"));
      if (child === undefined) {
        throw new Error("Expected Bash to have a PID while loading");
      }
      await wesh.kernel.kill({ pid: child.pid, signal });
    }
    await expect.poll(() => Promise.race([interrupted, undefined])).toMatchObject({
      result: { exitCode, waitStatus: { kind: "signaled", signal } },
      stdout: "",
      stderr: "",
    });
    expect(wesh.kernel.getProcesses()).toEqual(initialProcesses);

    const next = execute({ wesh, script: "/bin/bash -c 'printf reused'" });
    await expect.poll(() => wesh.kernel.getProcesses().some(({ args }) => args[0] === "/bin/bash" && args.includes("printf reused"))).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(implementation).not.toHaveBeenCalled();

    resume.resolve();
    await expect(next).resolves.toMatchObject({
      result: { exitCode: 0 },
      stdout: "reused",
      stderr: "",
    });
    expect(load).toHaveBeenCalledOnce();
    expect(implementation).toHaveBeenCalledOnce();
    expect(wesh.kernel.getProcesses()).toEqual(initialProcesses);
  });

  it("runs the EXIT trap on exec load failure and loads the replacement on retry", async () => {
    const { wesh, bash } = createWeshWithBashDefinition();
    await wesh.init();
    using load = vi.spyOn(bash, "load").mockRejectedValueOnce(new Error("lazy-bash-load-failed"));
    const script = "trap 'printf EXIT' EXIT; exec /bin/bash -c 'printf replaced'; printf NEXT";

    const failed = await execute({ wesh, script });
    expect(failed.result.exitCode).toBe(126);
    expect(failed.stdout).toBe("EXIT");
    expect(failed.stderr).toMatch(/^exec: .*lazy-bash-load-failed\n$/);

    const retried = await execute({ wesh, script });
    expect(retried.result.exitCode).toBe(0);
    expect(retried.stdout).toBe("replaced");
    expect(retried.stderr).toBe("");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      target: "ordinary",
      script: "bash -c 'trap \"\" INT; lazy-ignore-int; printf late'",
      waitingArgv0: "lazy-ignore-int",
    },
    {
      target: "exec",
      script: "sh -c 'trap \"\" INT; exec bash -c \"printf never\"'",
      waitingArgv0: "sh",
    },
  ])("stops a pending $target load after the process ignores a foreground SIGINT", async ({ target, script, waitingArgv0 }) => {
    const { wesh, bash } = createWeshWithBashDefinition();
    await wesh.init();
    const initialProcesses = wesh.kernel.getProcesses();
    const started = Promise.withResolvers<void>();
    const implementation = Promise.withResolvers<WeshCommandFunction>();
    const command = vi.fn<WeshCommandFunction>(async () => ({ exitCode: 0 }));
    using _release = {
      [Symbol.dispose]() {
        implementation.resolve(command);
      },
    };
    const load = () => {
      started.resolve();
      return implementation.promise;
    };
    if (target === "ordinary") {
      wesh.registerCommand({
        definition: {
          meta: { name: waitingArgv0, description: "Ordinary command with a pending load", usage: waitingArgv0 },
          load,
        },
      });
    }
    using _bashLoad = target === "exec" ? vi.spyOn(bash, "load").mockImplementation(load) : undefined;

    const controller = new AbortController();
    const execution = execute({ wesh, script, signal: controller.signal });
    await started.promise;
    const child = wesh.kernel.getProcesses().find(({ args }) => args[0] === waitingArgv0);
    expect(child?.signalDispositions?.get(2)).toBe("ignore");

    await expect(wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: controller.signal })).resolves.toBe(true);
    expect(child?.foregroundSignal?.aborted).toBe(false);
    expect(child?.waitStatus).toBeUndefined();
    expect(await Promise.race([execution, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();

    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    await expect.poll(() => Promise.race([execution, undefined])).toMatchObject({
      result: { exitCode: 130, waitStatus: { kind: "signaled", signal: 2 } },
      stdout: "",
      stderr: "",
    });
    expect(command).not.toHaveBeenCalled();
    expect(wesh.kernel.getProcesses()).toEqual(initialProcesses);
  });

  it("interrupts a shell builtin load and reuses its implementation in the next input", async () => {
    const wesh = createWesh();
    await wesh.init();
    const processes = wesh.kernel.getProcesses();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const loadPrintf = printfCommandDefinition.loadShellBuiltin;
    const load = vi.spyOn(printfCommandDefinition, "loadShellBuiltin").mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      return loadPrintf();
    });
    const spawn = vi.spyOn(wesh.kernel, "spawn");
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
        load.mockRestore();
        spawn.mockRestore();
      },
    };

    const interrupted = execute({ wesh, script: "printf should-not-run" });
    await started.promise;
    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);
    await expect.poll(() => Promise.race([interrupted, undefined])).toMatchObject({
      result: { exitCode: 130, waitStatus: { kind: "signaled", signal: 2 } },
      stdout: "",
      stderr: "",
    });

    resume.resolve();
    const next = await execute({ wesh, script: "printf resumed" });
    expect(next.result.exitCode).toBe(0);
    expect(next.stdout).toBe("resumed");
    expect(next.stderr).toBe("");
    expect(load).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(wesh.kernel.getProcesses()).toEqual(processes);
  });

  it("reports the interrupt when a pending shell builtin loader subsequently rejects", async () => {
    const wesh = createWesh();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _load = vi.spyOn(printfCommandDefinition, "loadShellBuiltin").mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      throw new Error("late-builtin-load-failure");
    });
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };

    const controller = new AbortController();
    const execution = execute({ wesh, script: "trap 'echo trapped >&2' INT; printf late", signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: controller.signal })).resolves.toBe(true);
    await expect.poll(() => Promise.race([execution, undefined])).toMatchObject({
      result: { exitCode: 130, waitStatus: { kind: "signaled", signal: 2 } },
      stdout: "",
      stderr: "trapped\n",
    });
    resume.resolve();
  });

  it("reaps the command process after a load failure and retries the load on the next call", async () => {
    const wesh = createWesh();
    await wesh.init();
    const initialProcessCount = wesh.kernel.getProcesses().length;
    const command: WeshCommandFunction = async ({ context }) => {
      await context.text().print({ text: "recovered\n" });
      return { exitCode: 0 };
    };
    const load = vi.fn<() => Promise<WeshCommandFunction>>()
      .mockRejectedValueOnce(new Error("lazy-load-failed"))
      .mockResolvedValue(command);
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
    expect(second.result.exitCode).toBe(0);
    expect(second.stdout).toBe("recovered\n");
    expect(second.stderr).toBe("");
    expect(wesh.kernel.getProcesses()).toHaveLength(initialProcessCount);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
