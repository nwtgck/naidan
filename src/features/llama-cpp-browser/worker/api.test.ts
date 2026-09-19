import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApi } from "./api";
import type { WorkerGenerateCall } from "./types";
import type { generate } from "./generation";

const calls = vi.hoisted(() => ({ generate: vi.fn<typeof generate>(), release: vi.fn(), remove: vi.fn(), list: vi.fn(), import: vi.fn() }));
vi.mock("./generation", () => ({ generate: calls.generate }));
vi.mock("./session", () => ({ invalidateStoredModel: calls.release }));
vi.mock("../runtime/model-store", () => ({ withModelStoreLock: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
  importStoredModel: calls.import, removeStoredModel: calls.remove, listStoredModels: calls.list }));
function request({ generationId }: { generationId: number }): WorkerGenerateCall {
  return { generationId, model: "local.gguf", assetBaseURL: "https://example.invalid/profiles/", options: { profile: "cpu-wasm32", contextSize: 256 },
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
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), () => {}, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    await api.cancelGeneration({ generationId: 2 }); expect(signal?.aborted).toBe(false);
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).rejects.toThrow("busy");
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(true);
    blocked.resolve(); await pending;
    calls.generate.mockImplementation(async args => {
      signal = args.signal;
    });
    await api.generate(request({ generationId: 2 }), () => {}, () => {});
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(false);
  });
  it("stops forwarding content emitted after cancellation while draining earlier proxy promises", async () => {
    const blocked = deferred(); const first = vi.fn(async () => blocked.promise); const chunk = vi.fn();
    calls.generate.mockImplementation(async ({ onProgress, onChunk }) => {
      onProgress({ progress: { phase: "loading", completed: 0, total: 1 } }); await blocked.promise;
      onChunk({ chunk: "not sent" });
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), chunk, first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await api.cancelGeneration({ generationId: 1 }); blocked.resolve(); await pending;
    expect(chunk).not.toHaveBeenCalled();
  });
  it("sanitizes proxy failures and can accept a later generation instead of keeping a stuck active owner", async () => {
    calls.generate.mockImplementation(async ({ onChunk }) => {
      onChunk({ chunk: "not logged" });
    });
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), async () => {
      throw new Error("private callback detail");
    }, () => {})).rejects.toThrow("llama.cpp browser: worker-failed");
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).resolves.toBeUndefined();
  });
  it("invalidates resident weights before deleting their stored model", async () => {
    const api = createWorkerApi(); const order: string[] = [];
    calls.release.mockImplementation(async () => {
      order.push("release");
    });
    calls.remove.mockImplementation(async () => {
      order.push("remove");
    });
    await api.removeModel({ id: "user/local-GGUF/local.gguf" });
    expect(order).toEqual(["release", "remove"]);
    expect(calls.release).toHaveBeenCalledWith({ id: "user/local-GGUF/local.gguf" });
    await expect(api.removeModel({ id: "../unsafe" })).rejects.toThrow();
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it("does not reuse an active id after a generation error", async () => {
    calls.generate.mockRejectedValueOnce(new Error("private native detail"));
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), () => {}, () => {})).rejects.toThrow("llama.cpp browser: runtime-error");
    calls.generate.mockResolvedValueOnce();
    await expect(api.generate(request({ generationId: 2 }), () => {}, () => {})).resolves.toBeUndefined();
  });
});
