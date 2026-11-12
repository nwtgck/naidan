// @vitest-environment node
import { READ_ENV_NAIDAN_MODEL_GRAPH_TEST_RUNTIME } from '../../../../build/node-env';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachCore, type Core, type CoreModule } from '@/features/llama-cpp-browser/runtime/core';
import { bindNativeChat } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import { createPositionSensitiveGguf } from '@/features/llama-cpp-browser/worker/test-utils/synthetic-gguf.test-support';
import { resolvedModelFixture } from '@/features/llama-cpp-browser/worker/test-utils/resolved-model.test-support';
import type { WorkerGenerateInput } from '@/features/llama-cpp-browser/worker/types';
import { bindModelGraphBoundary } from './native-boundary';
import { generateWithRegisteredGraph } from './generation';
import { releaseRegisteredGraph } from './session';
import { llamaGraphFixture } from './fixtures.test-support';
import { importModelGraphRegistrations, modelGraphRequestRegistrations, setModelGraphUseRule } from './registry';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';

const host = vi.hoisted(() => ({ core: undefined as Core | undefined, bytes: new Uint8Array(), releaseNative: vi.fn(), closes: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/worker/session', () => ({ prepareRuntime: async () => ({ core: host.core!, profile: 'cpu-wasm32' }), releaseSession: host.releaseNative }));
vi.mock('@/features/llama-cpp-browser/worker/model-file-access', () => ({
  openModelFileAccess: async () => ({
    getSize: () => host.bytes.length,
    read: (destination: Uint8Array, { at }: { at: number }) => {
      const count = Math.min(destination.length, host.bytes.length - at);
      destination.set(host.bytes.subarray(at, at + count));
      return count;
    },
    close: host.closes,
  }),
}));
vi.mock('@/features/llama-cpp-browser/worker/model-file-identity', () => ({ sameModelFile: async () => true }));

// Explicit test-runner asset path, never a model-supplied URI. The regular
// published legacy dependency need not contain the experimental native owner.
const runtime = READ_ENV_NAIDAN_MODEL_GRAPH_TEST_RUNTIME();

describe.skipIf(!runtime)('actual CI model graph extension, without native-boundary adapters', () => {
  beforeAll(async () => {
    if (!runtime) {
      throw new Error('Set the reviewed CI runtime directory');
    }
    const modulePath = pathToFileURL(path.join(runtime, 'core.mjs')).href;
    const loaded: unknown = await import(/* @vite-ignore */ modulePath);
    if (!loaded || typeof loaded !== 'object' || !('default' in loaded) || typeof loaded.default !== 'function') {
      throw new Error('Invalid test core factory');
    }
    const module: CoreModule & Parameters<typeof bindNativeChat>[0]['native'] = await loaded.default({ wasmBinary: await readFile(path.join(runtime, 'core.wasm')), print() {}, printErr() {} });
    host.core = { ...attachCore({ module, callMode: 'direct' }), chat: bindNativeChat({ native: module }) };
    await host.core.api.llama_backend_init();
  });

  afterEach(async () => {
    await releaseRegisteredGraph();
    vi.clearAllMocks();
  });

  it('recognizes the exact installed architecture registry and ABI fingerprint', () => {
    const boundary = bindModelGraphBoundary({ core: host.core! });
    expect(boundary.architectureKnown({ name: 'llama' })).toBe(true);
    expect(boundary.architectureKnown({ name: 'not-a-native-architecture' })).toBe(false);
  });

  it.each(['llama', 'novel'])('loads independent vocabulary and generates an approved %s graph end to end', async architecture => {
    const source = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
    const bytes = source.slice();
    if (architecture === 'novel') {
      const marker = new TextEncoder().encode('llama');
      const index = bytes.findIndex((_byte, at) => marker.every((value, i) => bytes[at + i] === value));
      if (index < 0) {
        throw new Error('Missing fixture architecture');
      }
      bytes.set(new TextEncoder().encode('novel'), index); // Equal byte length: no offset change.
    }
    host.bytes = new Uint8Array(bytes);
    const definition = llamaGraphFixture();
    definition.applicability.architecture = architecture;
    const registrations = importModelGraphRegistrations({ input: JSON.stringify(definition), existing: [] });
    const approved = setModelGraphUseRule({ registration: registrations[0]!, mode: architecture === 'llama' ? 'replaceNative' : 'whenArchitectureUnknown', registrations });
    const request: WorkerGenerateInput = {
      modelId: 'user/fixture',
      resolvedModel: resolvedModelFixture({ modelId: 'user/fixture' }),
      modelGraphRegistrations: modelGraphRequestRegistrations({ registrations: [approved] }),
      messages: [{ role: 'user', content: 'AB' }],
      temperature: 0,
      topP: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxTokens: 3,
      stop: [],
      options: { profile: 'cpu-wasm32', contextTokens: 128 },
      measurement: { sequence: 'fresh' },
    };
    const summaries: Diagnostic[] = [];
    const text: string[] = [];
    const native = vi.fn(async () => {
      throw new Error('Unexpected native-model fallback');
    });
    const generate = () => generateWithRegisteredGraph({
      request,
      signal: undefined,
      onProgress() {},
      onEvent: async ({ event }) => {
        if (event.type === 'text') {
          text.push(event.text);
        }
      },
      onSummary: ({ diagnostic }) => {
        summaries.push(diagnostic);
      },
      native,
    });
    const first = await generate();
    expect(text.join('')).toBe(first.content);
    expect(summaries[0]?.performance?.modelExecution).toMatchObject({ kind: 'registeredModelGraph', architecture, format: definition.format });
    expect(native).not.toHaveBeenCalled();
    expect(host.releaseNative).toHaveBeenCalledOnce();
    text.length = 0;
    const second = await generate();
    expect(second.content).toBe(first.content);
    expect(second.finishReason).toBe(first.finishReason);
    expect(text.join('')).toBe(second.content);
    expect(host.releaseNative).toHaveBeenCalledOnce(); // Native owner is reused, with request state reset.
    expect(host.closes).toHaveBeenCalled();
  });

  it('rejects non-finite logits at the actual native sampler boundary', async () => {
    const core = host.core!, boundary = bindModelGraphBoundary({ core });
    const workspace = boundary.createSamplerWorkspace({ vocabularySize: 3 });
    using _workspace = {
      [Symbol.dispose]() {
        workspace.close();
      },
    };
    const pointer = core.alloc({ bytes: 12 });
    using _memory = {
      [Symbol.dispose]() {
        core.free({ pointer });
      },
    };
    const sampler = await core.api.llama_sampler_init_greedy();
    await using _sampler = {
      async [Symbol.asyncDispose]() {
        await core.api.llama_sampler_free(sampler);
      },
    };
    for (const values of [[NaN, 0, 1], [Infinity, 0, 1], [-Infinity, -Infinity, -Infinity]]) {
      core.bytes({ pointer, length: 12 }).set(new Uint8Array(Float32Array.from(values).buffer));
      expect(() => workspace.sample({ sampler, logits: pointer })).toThrow();
    }
    core.bytes({ pointer, length: 12 }).set(new Uint8Array(Float32Array.from([0, 4, 1]).buffer));
    expect(workspace.sample({ sampler, logits: pointer })).toBe(1);
  });
});

export const TEST_ONLY = {
};
