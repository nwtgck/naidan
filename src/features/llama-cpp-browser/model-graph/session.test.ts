import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { WorkerPrepareInput } from '@/features/llama-cpp-browser/worker/types';
import { resolvedModelFixture } from '@/features/llama-cpp-browser/worker/test-utils/resolved-model.test-support';
import { createPositionSensitiveGguf } from '@/features/llama-cpp-browser/worker/test-utils/synthetic-gguf.test-support';
import { prepareRegisteredGraph, releaseRegisteredGraph } from './session';
import { importModelGraphRegistrations, setModelGraphUseRule } from './registry';
import { modelGraphRequestRegistrations } from './request-registry';
import { llamaGraphFixture } from './fixtures.test-support';

const calls = vi.hoisted(() => ({ open: vi.fn(), runtime: vi.fn(), releaseNative: vi.fn(), bind: vi.fn(), engine: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/worker/model-file-access', () => ({ openModelFileAccess: calls.open }));
vi.mock('@/features/llama-cpp-browser/worker/session', () => ({ prepareRuntime: calls.runtime, releaseSession: calls.releaseNative }));
vi.mock('@/features/llama-cpp-browser/worker/model-file-identity', () => ({ sameModelFile: async () => true }));
vi.mock('./native-boundary', () => ({ bindModelGraphBoundary: calls.bind, modelGraphNativeSchemaHash: 'b'.repeat(64) }));
vi.mock('./engine', () => ({ createModelGraphEngine: calls.engine }));

const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
const known = vi.fn(() => true), closeVocab = vi.fn(), closeEngine = vi.fn(), closeFile = vi.fn();
const vocabulary = { owner: 1n, vocab: 2n, close: closeVocab };
const createVocabulary = vi.fn(async () => vocabulary);
const vocabSize = vi.fn(async () => 259);
const engine = { close: closeEngine };

beforeEach(() => {
  vi.clearAllMocks();
  closeVocab.mockReset();
  closeEngine.mockReset();
  closeFile.mockReset();
  known.mockReturnValue(true);
  vocabSize.mockResolvedValue(259);
  calls.engine.mockResolvedValue(engine);
  createVocabulary.mockResolvedValue(vocabulary);
  calls.runtime.mockResolvedValue({ core: { api: { llama_vocab_n_tokens: vocabSize } } as unknown as Core, profile: 'cpu-wasm32' });
  calls.bind.mockReturnValue({ architectureKnown: known, createVocabulary });
  calls.open.mockImplementation(async () => ({
    getSize: () => bytes.length,
    read: (destination: Uint8Array, options: { at: number }) => {
      const n = Math.min(destination.length, bytes.length - options.at);
      destination.set(bytes.subarray(options.at, options.at + n));
      return n;
    },
    close: closeFile,
  }));
});

afterEach(async () => {
  await releaseRegisteredGraph();
});

function request({ mode }: { mode: 'when_architecture_unknown' | 'replace_native' }): WorkerPrepareInput {
  const imported = importModelGraphRegistrations({ input: JSON.stringify(llamaGraphFixture()), existing: [] });
  return { modelId: 'user/fixture', resolvedModel: resolvedModelFixture({ modelId: 'user/fixture' }), options: { profile: 'cpu-wasm32', contextTokens: 128 }, modelGraphRegistrations: modelGraphRequestRegistrations({ registrations: [setModelGraphUseRule({ registration: imported[0]!, mode, registrations: imported })] }) };
}

const prepare = ({ value }: { value: WorkerPrepareInput }) => prepareRegisteredGraph({ request: value, signal: undefined, onProgress() {}, purpose: 'text' });

describe('request-boundary model graph authority and ownership', () => {
  it('does not touch a runtime or model file when disabled', async () => {
    expect(await prepare({ value: { ...request({ mode: 'replace_native' }), modelGraphRegistrations: [] } })).toBeUndefined();
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.runtime).not.toHaveBeenCalled();
    expect(calls.releaseNative).not.toHaveBeenCalled();
  });

  it('keeps the loaded native model and its caches for an inapplicable unknown-only rule', async () => {
    expect(await prepare({ value: request({ mode: 'when_architecture_unknown' }) })).toBeUndefined();
    expect(calls.runtime).toHaveBeenCalledOnce();
    expect(calls.releaseNative).not.toHaveBeenCalled();
    expect(calls.engine).not.toHaveBeenCalled();
  });

  it('uses an unknown-only rule only after the actual runtime reports unknown', async () => {
    known.mockReturnValue(false);
    expect(await prepare({ value: request({ mode: 'when_architecture_unknown' }) })).toBeDefined();
    expect(calls.releaseNative).toHaveBeenCalledWith({ releaseRuntime: false });
  });

  it('reuses a matching owner, changes its label without changing semantics, and releases on disable', async () => {
    const value = request({ mode: 'replace_native' });
    const first = await prepare({ value });
    const second = await prepare({ value: { ...value, modelGraphRegistrations: value.modelGraphRegistrations!.map(entry => ({ ...entry, label: 'Renamed' })) } });
    expect(second).toBe(first);
    expect(second?.execution.label).toBe('Renamed');
    expect(calls.engine).toHaveBeenCalledOnce();
    await prepare({ value: { ...value, modelGraphRegistrations: [] } });
    expect(closeEngine).toHaveBeenCalledOnce();
    expect(closeVocab).toHaveBeenCalledOnce();
  });

  it('rebuilds on context changes and never retains an old definition after replacement', async () => {
    const value = request({ mode: 'replace_native' });
    await prepare({ value });
    await prepare({ value: { ...value, options: { ...value.options, contextTokens: 256 } } });
    expect(calls.engine).toHaveBeenCalledTimes(2);
    expect(closeVocab).toHaveBeenCalledOnce();
    const changed = { ...value, modelGraphRegistrations: value.modelGraphRegistrations!.map(entry => ({ ...entry, source: '{}' })) };
    await expect(prepare({ value: changed })).rejects.toThrow('stale');
    expect(calls.engine).toHaveBeenCalledTimes(2);
  });

  it.each(['vision', 'audio', 'live'] as const)('does not silently fall back for unsupported %s input', async purpose => {
    await expect(prepareRegisteredGraph({ request: request({ mode: 'replace_native' }), signal: undefined, onProgress() {}, purpose })).rejects.toThrow('unsupported-input');
    expect(calls.engine).not.toHaveBeenCalled();
    expect(calls.releaseNative).not.toHaveBeenCalled();
  });

  it('releases vocabulary and files after a graph allocation failure', async () => {
    calls.engine.mockRejectedValueOnce(new Error('allocation rejected'));
    await expect(prepare({ value: request({ mode: 'replace_native' }) })).rejects.toThrow('allocation rejected');
    expect(closeVocab).toHaveBeenCalledOnce();
    expect(closeFile).toHaveBeenCalledTimes(2);
    await releaseRegisteredGraph();
    expect(closeVocab).toHaveBeenCalledOnce();
  });

  it('rejects a tokenizer inventory mismatch before graph allocation', async () => {
    vocabSize.mockResolvedValueOnce(260);
    await expect(prepare({ value: request({ mode: 'replace_native' }) })).rejects.toThrow('vocabulary size');
    expect(closeVocab).toHaveBeenCalledOnce();
    expect(calls.engine).not.toHaveBeenCalled();
  });

  it('never turns a missing native extension into an implicit native fallback', async () => {
    calls.bind.mockImplementationOnce(() => {
      throw new Error('missing native extension');
    });
    await expect(prepare({ value: request({ mode: 'replace_native' }) })).rejects.toThrow('missing native extension');
    expect(calls.releaseNative).not.toHaveBeenCalled();
  });

  it('preserves the allocation error while attempting every failing cleanup', async () => {
    calls.engine.mockRejectedValueOnce(new Error('primary allocation failure'));
    closeFile.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error('secondary file close failure');
    });
    closeVocab.mockImplementationOnce(() => {
      throw new Error('secondary vocabulary close failure');
    });
    await expect(prepare({ value: request({ mode: 'replace_native' }) })).rejects.toThrow('primary allocation failure');
    expect(closeVocab).toHaveBeenCalledOnce();
    expect(closeFile).toHaveBeenCalledTimes(2);
    await releaseRegisteredGraph();
    expect(closeVocab).toHaveBeenCalledOnce();
  });

  it('does not retain a successful graph when a source handle fails to close', async () => {
    closeFile.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error('file close failure');
    });
    await expect(prepare({ value: request({ mode: 'replace_native' }) })).rejects.toThrow('file close failure');
    expect(closeEngine).toHaveBeenCalledOnce();
    expect(closeVocab).toHaveBeenCalledOnce();
    await prepare({ value: request({ mode: 'replace_native' }) });
    expect(calls.engine).toHaveBeenCalledTimes(2);
  });

  it('closes the vocabulary and forgets the owner even when both destructors fail', async () => {
    await prepare({ value: request({ mode: 'replace_native' }) });
    closeEngine.mockRejectedValueOnce(new Error('engine close failure'));
    closeVocab.mockImplementationOnce(() => {
      throw new Error('vocabulary close failure');
    });
    await expect(releaseRegisteredGraph()).rejects.toThrow('engine close failure');
    expect(calls.releaseNative).toHaveBeenCalledWith({ releaseRuntime: true });
    expect(closeEngine).toHaveBeenCalledOnce();
    expect(closeVocab).toHaveBeenCalledOnce();
    await releaseRegisteredGraph();
    expect(closeVocab).toHaveBeenCalledOnce();
  });
});
