// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import { TransformersJsProvider } from './provider-standalone';

const request = { messages: [], model: 'local-model', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined } satisfies Parameters<LmProvider['chat']>[0];

afterEach(() => vi.unstubAllGlobals());

describe('standalone Transformers.js provider contract', () => {
  it('returns a local generation error without a hosted runtime or network operation', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network access');
    });
    const Worker = vi.fn(() => {
      throw new Error('Unexpected worker creation');
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('Worker', Worker);
    const provider: LmProvider = new TransformersJsProvider();
    const stream = provider.chat(request);
    const values = [];
    for await (const item of stream) values.push(item);
    expect(values).toEqual([{ type: 'result', result: { type: 'error', error: new Error('Transformers.js is not available in standalone mode') } }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('does not create an error part when cancelled before consumption', async () => {
    const controller = new AbortController();
    controller.abort();
    const values = [];
    for await (const item of new TransformersJsProvider().chat({ debug: undefined, ...request, signal: controller.signal })) values.push(item);
    expect(values).toEqual([{ type: 'result', result: { type: 'interrupted', reason: 'aborted' } }]);
  });

  it('can be abandoned without starting a runtime or leaving a pending read', async () => {
    const iterator = new TransformersJsProvider().chat(request)[Symbol.asyncIterator]();
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('still lists no locally available models', async () => {
    expect(await new TransformersJsProvider().listModels({ signal: undefined })).toEqual([]);
  });
});
