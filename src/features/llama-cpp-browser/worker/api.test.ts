import { audioResult } from '@/features/audio-generation/test-utils/wav';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import type { generateAudio } from './audio-generation';
import type { WorkerAudioCall } from './types';
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { logNativeDiagnostic, logOperation } from '@/features/llama-cpp-browser/debug-log';
import type { importStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApi } from "./api";
import type { WorkerGenerateCall } from "./types";
import type { generate } from "./generation";

const result = { content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' } as const;
const completed = () => ({ ...result, toolCalls: [] });
const calls = vi.hoisted(() => ({ audio: vi.fn<typeof generateAudio>(), probe: vi.fn(), generate: vi.fn<typeof generate>(), release: vi.fn(), releaseSession: vi.fn(), remove: vi.fn(), list: vi.fn(), import: vi.fn(), importDirectory: vi.fn() }));
vi.mock("@/features/llama-cpp-browser/runtime/detect-profile", () => ({ probeRuntimeProfiles: calls.probe }));
vi.mock("../runtime/model-directory", () => ({ importModelDirectory: calls.importDirectory }));
vi.mock("./audio-generation", () => ({ generateAudio: calls.audio }));
vi.mock("./generation", () => ({ generate: calls.generate }));
vi.mock("./session", () => ({ invalidateStoredModel: calls.release, releaseSession: calls.releaseSession }));
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
  vi.clearAllMocks(); calls.audio.mockReset(); calls.audio.mockResolvedValue(audioResult()); calls.list.mockResolvedValue([]); calls.remove.mockResolvedValue(undefined); calls.release.mockResolvedValue(undefined);
});
describe("generation RPC lifecycle", () => {
  it('probes browser capabilities without loading a model or generating', async () => {
    const capabilities = { recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] };
    calls.probe.mockResolvedValueOnce(capabilities);
    expect(await createWorkerApi().probeProfiles()).toEqual(capabilities);
    expect(calls.generate).not.toHaveBeenCalled(); expect(calls.releaseSession).not.toHaveBeenCalled();
  });
  it('releases idle native state and refuses cleanup while generation owns it', async () => {
    const api = createWorkerApi();
    await api.release();
    expect(calls.releaseSession).toHaveBeenCalledWith({ releaseRuntime: true });
    calls.releaseSession.mockClear();
    const blocked = deferred();
    calls.generate.mockImplementationOnce(async () => {
      await blocked.promise; return completed();
    });
    const generating = api.generate(request({ generationId: 1 }), async () => {}, () => {});
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    await expect(api.release()).rejects.toThrow('busy');
    expect(calls.releaseSession).not.toHaveBeenCalled();
    blocked.resolve(); await generating;
    await api.release();
    expect(calls.releaseSession).toHaveBeenCalledOnce();
  });
  it("posts native callbacks immediately and drains their acknowledgements before RPC completion", async () => {
    const blocked = deferred(); const events: string[] = [];
    calls.generate.mockImplementation(async ({ onProgress, onEvent }) => {
      onProgress({ progress: { phase: "loading", completed: 1, total: 1 } });
      onProgress({ progress: { phase: "prefill", completed: 2, total: 2 } });
      await onEvent({ event: { type: "text", text: "first" } }); await onEvent({ event: { type: "text", text: "second" } });
      return completed();
    });
    const api = createWorkerApi(); let settled = false;
    const pending = api.generate(request({ generationId: 1 }), async ({ event }) => {
      if (event.type === "text") events.push(event.text);
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
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), async () => {}, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    await api.cancelGeneration({ generationId: 2 }); expect(signal?.aborted).toBe(false);
    await expect(api.generate(request({ generationId: 2 }), async () => {}, () => {})).rejects.toThrow("busy");
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(true);
    blocked.resolve(); await pending;
    calls.generate.mockImplementation(async args => {
      signal = args.signal;
      return completed();
    });
    await api.generate(request({ generationId: 2 }), async () => {}, () => {});
    await api.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(false);
  });
  it("drains already accepted content after cancellation and waits for proxy acknowledgements", async () => {
    const blocked = deferred(); const first = vi.fn(async () => blocked.promise); const chunk = vi.fn();
    calls.generate.mockImplementation(async ({ onProgress, onEvent }) => {
      onProgress({ progress: { phase: "loading", completed: 0, total: 1 } }); await blocked.promise;
      await onEvent({ event: { type: "text", text: "accepted before cancellation" } });
      return completed();
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 1 }), chunk, first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await api.cancelGeneration({ generationId: 1 }); blocked.resolve(); await pending;
    expect(chunk).toHaveBeenCalledWith({ event: { type: "text", text: "accepted before cancellation" } });
  });
  it("sanitizes proxy failures and can accept a later generation instead of keeping a stuck active owner", async () => {
    calls.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: "text", text: "not logged" } });
      return completed();
    });
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), async () => {
      throw new Error("private callback detail");
    }, () => {})).rejects.toThrow("llama.cpp browser: worker-failed");
    await expect(api.generate(request({ generationId: 2 }), async () => {}, () => {})).resolves.toEqual(completed());
  });
  it("invalidates resident weights before deleting their stored model", async () => {
    const api = createWorkerApi(); const order: string[] = [];
    calls.release.mockImplementation(async () => {
      order.push("release");
    });
    calls.remove.mockImplementation(async () => {
      order.push("remove");
    });
    await api.removeModel({ plan: { id: "user/local-GGUF", files: [] } });
    expect(order).toEqual(["release", "remove"]);
    expect(calls.release).toHaveBeenCalledWith({ id: "user/local-GGUF" });
    await expect(api.removeModel({ plan: { id: "../unsafe", files: [] } })).rejects.toThrow();
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it("does not reuse an active id after a generation error", async () => {
    calls.generate.mockRejectedValueOnce(new Error("private native detail"));
    const api = createWorkerApi();
    await expect(api.generate(request({ generationId: 1 }), async () => {}, () => {})).rejects.toThrow("llama.cpp browser: runtime-error");
    calls.generate.mockResolvedValueOnce(completed());
    await expect(api.generate(request({ generationId: 2 }), async () => {}, () => {})).resolves.toEqual(completed());
  });
});

describe('directory import RPC', () => {
  it('routes cancellation to the importer and rejects overlapping work', async () => {
    const blocked = deferred(); let signal: AbortSignal | undefined;
    calls.importDirectory.mockImplementation(async (args: Parameters<typeof importModelDirectory>[0]) => {
      signal = args.signal; await blocked.promise; if (signal?.aborted) throw new Error('llama.cpp browser: aborted'); return { id: 'user/Model', name: 'Model', size: 1, importedAt: 1 };
    });
    const api = createWorkerApi(); const pending = api.importDirectory({ directory: { name: 'Model', files: [{ path: 'model.gguf', file: new File(['data'], 'model.gguf') }] }, generationId: 4 }, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(api.generate(request({ generationId: 5 }), async () => {}, () => {})).rejects.toThrow('busy');
    await api.cancelGeneration({ generationId: 3 }); expect(signal?.aborted).toBe(false);
    await api.cancelGeneration({ generationId: 4 }); expect(signal?.aborted).toBe(true);
    blocked.resolve(); await expect(pending).rejects.toThrow('aborted');
  });
});

describe('native diagnostic checkpoints', () => {
  it.each(['success', 'failure', 'cancel'] as const)('scopes detailed output to a request and releases it after %s', async outcome => {
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      const pending = api.generate({ ...request({ generationId: 1 }), debug: 'on' }, async () => {}, () => {}, receive);
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
      await api.generate({ ...request({ generationId: 2 }), debug: 'off' }, async () => {}, () => {}, receive);
      expect(debug).not.toHaveBeenCalled(); expect(receive).toHaveBeenCalledTimes(2);
      await api.generate({ ...request({ generationId: 3 }), debug: 'on' }, async () => {}, () => {}, receive);
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
    const pending = createWorkerApi().generate(request({ generationId: 1 }), async () => {}, () => {}, receive);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(nativeEntered).toBe(false); blocked.resolve(); await pending;
    expect(nativeEntered).toBe(true);
    await logOperation({ diagnostic: { event: 'operation-complete', stage: 'image-evaluate', statusCode: 0 } });
    expect(receive).toHaveBeenCalledOnce();
  });
});


describe('single-file import RPC cancellation', () => {
  it('routes the request id to the importer and waits for rollback and callback acknowledgements', async () => {
    const rollback = deferred(); const acknowledged = deferred(); let input: Parameters<typeof importStoredModel>[0] | undefined;
    const model = { id: 'user/same-GGUF', name: 'same-GGUF', size: 7, importedAt: 1 };
    calls.import.mockImplementationOnce(async (args: Parameters<typeof importStoredModel>[0]) => {
      input = args; args.onProgress({ progress: { phase: 'importing', completed: 1, total: 7 } });
      await rollback.promise;
      if (args.signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
      return model;
    });
    const file = new File(['fixture'], 'same.gguf'); const api = createWorkerApi(); const progress = vi.fn(() => acknowledged.promise);
    const pending = api.importModel({ file, generationId: 4 }, progress);
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(input?.signal).toBeDefined());
    expect(input?.file).toBe(file);
    await api.cancelGeneration({ generationId: 3 }); expect(input?.signal?.aborted).toBe(false);
    await api.cancelGeneration({ generationId: 4 }); expect(input?.signal?.aborted).toBe(true);
    input?.onProgress({ progress: { phase: 'importing', completed: 7, total: 7 } }); expect(progress).toHaveBeenCalledOnce();
    await expect(api.importModel({ file, generationId: 5 }, () => {})).rejects.toThrow('busy');
    await expect(api.importDirectory({ directory: { name: 'Folder', files: [{ path: file.name, file }] }, generationId: 5 }, () => {})).rejects.toThrow('busy');
    await expect(api.generate(request({ generationId: 5 }), async () => {}, () => {})).rejects.toThrow('busy');
    rollback.resolve();
    await expect(api.release()).rejects.toThrow('busy');
    acknowledged.resolve(); await rejected;
    calls.import.mockImplementationOnce(async (args: Parameters<typeof importStoredModel>[0]) => {
      input = args; return model;
    });
    await expect(api.importModel({ file, generationId: 6 }, () => {})).resolves.toEqual(model);
    await api.cancelGeneration({ generationId: 4 }); expect(input?.signal?.aborted).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid single-file cancellation id %s before touching storage', async generationId => {
    await expect(createWorkerApi().importModel({ file: new File(['fixture'], 'same.gguf'), generationId }, () => {})).rejects.toThrow();
    expect(calls.import).not.toHaveBeenCalled();
  });
});

function audioRequest({ generationId }: { generationId: number }): WorkerAudioCall {
  return { ...defaultAudioParameters(), generationId, model: 'user/voice', text: 'Hello', options: { profile: 'cpu-wasm32' }, debug: 'off' };
}
describe('audio RPC ownership', () => {
  it('validates audio inputs before allocating native state', async () => {
    await expect(createWorkerApi().generateAudio({ ...audioRequest({ generationId: 1 }), text: ' ' }, () => {}, () => {})).rejects.toThrow();
    expect(calls.audio).not.toHaveBeenCalled();
  });
  it('drains progress acknowledgements before permitting another operation', async () => {
    const gate = deferred(); calls.audio.mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ progress: { phase: 'generating', completed: 1, total: 2 } }); return audioResult();
    });
    const api = createWorkerApi(); let settled = false;
    const pending = api.generateAudio(audioRequest({ generationId: 1 }), () => gate.promise, () => {}).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(calls.audio).toHaveBeenCalledOnce()); expect(settled).toBe(false);
    await expect(api.generate(request({ generationId: 2 }), async () => {}, () => {})).rejects.toThrow('busy');
    await expect(api.release()).rejects.toThrow('busy'); gate.resolve(); await pending; await api.release();
    expect(calls.releaseSession).toHaveBeenCalledWith({ releaseRuntime: true });
  });
  it('targets audio cancellation by its ID and prevents chat/audio overlap', async () => {
    const gate = deferred(); let signal: AbortSignal | undefined;
    calls.audio.mockImplementationOnce(async args => {
      signal = args.signal; await gate.promise; return audioResult();
    });
    const api = createWorkerApi(); const pending = api.generateAudio(audioRequest({ generationId: 7 }), () => {}, () => {});
    await vi.waitFor(() => expect(calls.audio).toHaveBeenCalledOnce());
    await expect(api.generateAudio(audioRequest({ generationId: 8 }), () => {}, () => {})).rejects.toThrow('busy');
    await api.cancelGeneration({ generationId: 6 }); expect(signal?.aborted).toBe(false);
    await api.cancelGeneration({ generationId: 7 }); expect(signal?.aborted).toBe(true); gate.resolve(); await pending;
    expect(await api.generateAudio(audioRequest({ generationId: 8 }), () => {}, () => {})).toEqual(audioResult());
  });
  it('rejects invalid native results and releases the active operation slot', async () => {
    calls.audio.mockResolvedValueOnce({ ...audioResult(), sampleRate: 0 }); const api = createWorkerApi();
    await expect(api.generateAudio(audioRequest({ generationId: 1 }), () => {}, () => {})).rejects.toThrow();
    expect(await api.generateAudio(audioRequest({ generationId: 2 }), () => {}, () => {})).toEqual(audioResult());
  });
  it('propagates callback failure after cleanup rather than leaking an occupied slot', async () => {
    calls.audio.mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ progress: { phase: 'generating', completed: 1, total: 2 } }); return audioResult();
    });
    const api = createWorkerApi();
    await expect(api.generateAudio(audioRequest({ generationId: 1 }), () => Promise.reject(new Error('callback failed')), () => {})).rejects.toThrow('worker-failed');
    await api.release();
  });
});


describe('request-scoped audio finishing', () => {
  it('finishes only the matching audio request without aborting its native operation', async () => {
    const gate = deferred(); calls.audio.mockImplementationOnce(async () => {
      await gate.promise; return { ...audioResult(), finishReason: 'user-stop' };
    });
    const api = createWorkerApi(); const pending = api.generateAudio(audioRequest({ generationId: 71 }), () => {}, () => {});
    await vi.waitFor(() => expect(calls.audio).toHaveBeenCalledOnce());
    const operation = calls.audio.mock.calls[0]![0]; expect(operation.shouldFinish?.()).toBe(false);
    await api.finishAudioGeneration({ generationId: 70 }); expect(operation.shouldFinish?.()).toBe(false);
    await api.finishAudioGeneration({ generationId: 71 }); expect(operation.shouldFinish?.()).toBe(true);
    expect(operation.signal?.aborted).toBe(false);
    gate.resolve(); expect(await pending).toMatchObject({ finishReason: 'user-stop' });
    await api.finishAudioGeneration({ generationId: 71 });
    await api.generateAudio(audioRequest({ generationId: 72 }), () => {}, () => {});
    expect(calls.audio.mock.calls[1]![0].shouldFinish?.()).toBe(false);
  });
  it('does not finish or cancel a chat operation, including when its ID matches', async () => {
    const gate = deferred(); calls.generate.mockImplementationOnce(async () => {
      await gate.promise; return completed();
    });
    const api = createWorkerApi(); const pending = api.generate(request({ generationId: 91 }), async () => {}, () => {});
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    await api.finishAudioGeneration({ generationId: 91 });
    expect(calls.generate.mock.calls[0]![0].signal?.aborted).toBe(false); expect(calls.audio).not.toHaveBeenCalled();
    gate.resolve(); await pending;
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid finish request ID %s', async generationId => {
    await expect(createWorkerApi().finishAudioGeneration({ generationId })).rejects.toThrow();
    expect(calls.audio).not.toHaveBeenCalled();
  });
});
