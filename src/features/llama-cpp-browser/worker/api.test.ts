import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { logNativeDiagnostic, logOperation } from '@/features/llama-cpp-browser/debug-log';
import type { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApi } from "./api";
import type { WorkerGenerateCall } from "./types";
import type { generate } from "./generation";

const result = { content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' } as const;
const completed = () => ({ ...result, toolCalls: [] });
const calls = vi.hoisted(() => ({ generate: vi.fn<typeof generate>(), release: vi.fn(), remove: vi.fn(), list: vi.fn(), import: vi.fn(), importDirectory: vi.fn() }));
vi.mock("../runtime/model-directory", () => ({ importModelDirectory: calls.importDirectory }));
vi.mock("./generation", () => ({ generate: calls.generate }));
vi.mock("./session", () => ({ invalidateStoredModel: calls.release }));
vi.mock("../runtime/model-store", () => ({ withModelStoreLock: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
  importStoredModel: calls.import, removeStoredModel: calls.remove, listStoredModels: calls.list }));
function request({ generationId }: { generationId: number }): WorkerGenerateCall {
  return { generationId, model: "local.gguf", assetBaseURL: "https://example.invalid/profiles/", options: { profile: "cpu-wasm32" },
    messages: [{ role: "user", content: "hello" }], temperature: 0, topP: 1, maxTokens: 10, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); calls.list.mockResolvedValue([]); calls.remove.mockResolvedValue(undefined); calls.release.mockResolvedValue(undefined);
});
describe("generation RPC lifecycle", () => {
  it("posts native callbacks immediately and drains their acknowledgements before RPC completion", async () => {
    const blocked = deferred(); const events: string[] = [];
    calls.generate.mockImplementation(async ({ onProgress, onChunk }) => {
      onProgress({ progress: { phase: "loading", completed: 1, total: 1 } });
      onProgress({ progress: { phase: "prefill", completed: 2, total: 2 } });
      onChunk({ chunk: "first" }); onChunk({ chunk: "second" });
      return completed();
    });
    const api = createWorkerApi(); let settled = false;
    const pending = api.generate(request({ generationId: 1 }), async ({ text }) => {
      events.push(text);
    },
    async ({ phase }) => {
      events.push(phase); if (phase === "loading") await blocked.promise;
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(events).toEqual(["loading", "prefill", "first", "second"]));
    expect(settled).toBe(false); blocked.resolve(); await pending;
    expect(events).toEqual(["loading", "prefill", "first", "second"]); expect(settled).toBe(true);
  });
  it("targets cancellation by generation id, bypasses the held generation lane, and then accepts new work", async () => {
    const blocked = deferred(); let signal: AbortSignal | undefined;
    calls.generate.mockImplementation(async args => {
      signal = args.signal; await blocked.promise;
      return completed();
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), () => {}, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    await api.cancelGeneration({ generationId: 2 }); expect(signal?.aborted).toBe(false);
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).rejects.toThrow("busy");
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(true);
    blocked.resolve(); await pending;
    calls.generate.mockImplementation(async args => {
      signal = args.signal;
      return completed();
    });
    await api.generate(request({ generationId: 2 }), () => {}, () => {});
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(false);
  });
  it("stops forwarding content emitted after cancellation while draining earlier proxy promises", async () => {
    const blocked = deferred(); const first = vi.fn(async () => blocked.promise); const chunk = vi.fn();
    calls.generate.mockImplementation(async ({ onProgress, onChunk }) => {
      onProgress({ progress: { phase: "loading", completed: 0, total: 1 } }); await blocked.promise;
      onChunk({ chunk: "not sent" });
      return completed();
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), chunk, first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await api.cancelGeneration({ generationId: 1 }); blocked.resolve(); await pending;
    expect(chunk).not.toHaveBeenCalled();
  });
  it("sanitizes proxy failures and can accept a later generation instead of keeping a stuck active owner", async () => {
    calls.generate.mockImplementation(async ({ onChunk }) => {
      onChunk({ chunk: "not logged" });
      return completed();
    });
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), async () => {
      throw new Error("private callback detail");
    }, () => {})).rejects.toThrow("llama.cpp browser: worker-failed");
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).resolves.toEqual(completed());
  });
  it("invalidates resident weights before deleting their stored model", async () => {
    const api = createWorkerApi(); const order: string[] = [];
    calls.release.mockImplementation(async () => {
      order.push("release");
    });
    calls.remove.mockImplementation(async () => {
      order.push("remove");
    });
    await api.removeModel({ plan: { id: "user/local-GGUF/local.gguf", files: [] } });
    expect(order).toEqual(["release", "remove"]);
    expect(calls.release).toHaveBeenCalledWith({ id: "user/local-GGUF/local.gguf" });
    await expect(api.removeModel({ plan: { id: "../unsafe", files: [] } })).rejects.toThrow();
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it("does not reuse an active id after a generation error", async () => {
    calls.generate.mockRejectedValueOnce(new Error("private native detail"));
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), () => {}, () => {})).rejects.toThrow("llama.cpp browser: runtime-error");
    calls.generate.mockResolvedValueOnce(completed());
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).resolves.toEqual(completed());
  });
});

describe('directory import RPC', () => {
  it('routes cancellation to the importer and rejects overlapping work', async () => {
    const blocked = deferred(); let signal: AbortSignal | undefined;
    calls.importDirectory.mockImplementation(async (args: Parameters<typeof importModelDirectory>[0]) => {
      signal = args.signal; await blocked.promise; if (signal?.aborted) throw new Error('llama.cpp browser: aborted'); return { id: 'Model', name: 'Model', size: 1, importedAt: 1 };
    });
    const api = createWorkerApi(); const pending = api.importDirectory({ directory: { name: 'Model', files: [{ path: 'model.gguf', file: new File(['data'], 'model.gguf') }] }, generationId: 4 }, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(api.generate(request({ generationId: 5 }), () => {}, () => {})).rejects.toThrow('busy');
    await api.cancelGeneration({ generationId: 3 }); expect(signal?.aborted).toBe(false);
    await api.cancelGeneration({ generationId: 4 }); expect(signal?.aborted).toBe(true);
    blocked.resolve(); await expect(pending).rejects.toThrow('aborted');
  });
});

describe('native diagnostic checkpoints', () => {
  it.each(['success', 'failure', 'cancel'] as const)('scopes detailed output to a request and releases it after %s', async outcome => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // A resident core retains this callback, never a particular request preference.
    const residentPrintErr = () => logNativeDiagnostic({ message: 'encoding image slice...' });
    const blocked = deferred(); const entered = deferred();
    const api = createWorkerApi(); const receive = vi.fn();
    calls.generate.mockImplementationOnce(async () => {
      await logOperation({ diagnostic: { event: 'operation-start', stage: 'image-evaluate' } });
      residentPrintErr(); entered.resolve(); await blocked.promise;
      switch (outcome) {
      case 'success': case 'cancel': return completed();
      case 'failure': throw new Error('private failure');
      default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
      }
    });
    try {
      const pending = api.generate({ ...request({ generationId: 1 }), debug: 'on' }, () => {}, () => {}, receive);
      const settled = pending.catch(() => undefined);
      await entered.promise;
      expect(readDiagnostics({ calls: debug.mock.calls }).filter(value => value.event === 'operation-start')).toHaveLength(2);
      if (outcome === 'cancel') await api.cancelGeneration({ generationId: 1 });
      blocked.resolve(); await settled;
      debug.mockClear(); residentPrintErr(); expect(debug).not.toHaveBeenCalled();
      calls.generate.mockImplementation(async () => {
        await logOperation({ diagnostic: { event: 'operation-start', stage: 'image-evaluate' } });
        residentPrintErr(); return completed();
      });
      receive.mockClear();
      await api.generate({ ...request({ generationId: 2 }), debug: 'off' }, () => {}, () => {}, receive);
      expect(debug).not.toHaveBeenCalled(); expect(receive).toHaveBeenCalledTimes(2);
      await api.generate({ ...request({ generationId: 3 }), debug: 'on' }, () => {}, () => {}, receive);
      expect(readDiagnostics({ calls: debug.mock.calls }).filter(value => value.event === 'operation-start')).toHaveLength(2);
    } finally {
      debug.mockRestore();
    }
  });
  it('waits for the host to record the native stage before the operation runs', async () => {
    const blocked = deferred(); let nativeEntered = false;
    calls.generate.mockImplementation(async () => {
      await logOperation({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 101 } });
      nativeEntered = true; return completed();
    });
    const receive = vi.fn(async () => blocked.promise);
    const pending = createWorkerApi().generate(request({ generationId: 1 }), () => {}, () => {}, receive);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(nativeEntered).toBe(false); blocked.resolve(); await pending;
    expect(nativeEntered).toBe(true);
    await logOperation({ diagnostic: { event: 'operation-complete', stage: 'image-evaluate', statusCode: 0 } });
    expect(receive).toHaveBeenCalledOnce();
  });
});
