// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore, type Core } from 'llama-cpp-browser-core';
import { generate } from './generation';
import { createSyntheticGguf } from './test-utils/synthetic-gguf';
import type { WorkerGenerateInput } from './types';

const host = vi.hoisted(() => ({ bytes: new Uint8Array(), reads: 0, maxRead: 0, close: vi.fn(), core: undefined as Core | undefined }));
vi.mock('../runtime/model-store', () => ({ storedModelHandle: async () => ({ createSyncAccessHandle: async () => ({
  getSize: () => host.bytes.length,
  read: (target: Uint8Array, { at }: { at: number }) => {
    host.reads++; host.maxRead = Math.max(host.maxRead, target.length); const n = Math.min(target.length, host.bytes.length - at); target.set(host.bytes.subarray(at, at + n)); return n;
  },
  close: host.close,
}) }) }));
vi.mock('../runtime/load-runtime', () => ({ loadRuntime: async () => {
  // Real supplied Wasm, not a mock core. Only file access and runtime deployment are injected.
  const folder = path.resolve('node_modules/llama-cpp-browser-core');
  host.core = await createCore({ profile: 'cpu-wasm32', baseURL: pathToFileURL(folder + '/profiles/'), moduleOptions: {
    wasmBinary: await readFile(path.join(folder, 'profiles/cpu-wasm32/core.wasm')), print() {}, printErr() {},
  } });
  await host.core.api.llama_backend_init();
  return host.core;
} }));
afterAll(async () => {
  await host.core?.api.llama_backend_free();
});
function request({ contextSize, messages }: { contextSize: number, messages: WorkerGenerateInput['messages'] }): WorkerGenerateInput {
  return { model: 'private-local-name.gguf', messages, temperature: 0, topP: 0.95, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32', contextSize }, assetBaseURL: 'https://example.invalid/runtime/' };
}
describe('Naidan generation loop with the supplied CPU Wasm', () => {
  it('loads a chat-template GGUF, prefills, generates and closes the reader without logging content', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf());
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const chunks: string[] = []; const phases: string[] = [];
    await generate({ request: request({ contextSize: 256, messages: [{ role: 'user', content: 'private prompt' }] }),
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onProgress: ({ progress }) => {
        phases.push(progress.phase);
      } });
    expect(chunks.join('')).toBe('<unk><unk><unk><unk><unk>');
    expect(phases).toContain('loading'); expect(phases).toContain('prefill'); expect(phases).toContain('generating');
    expect(host.reads).toBeGreaterThan(0); expect(host.maxRead).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(host.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('<unk>');
    debug.mockRestore();
  }, 30000);
  it('rejects an oversized prompt and still releases the model reader', async () => {
    const before = host.close.mock.calls.length;
    await expect(generate({ request: request({ contextSize: 128, messages: [{ role: 'user', content: 'long prompt '.repeat(300) }] }), onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('context-full');
    expect(host.close).toHaveBeenCalledTimes(before + 1);
  }, 30000);
});
