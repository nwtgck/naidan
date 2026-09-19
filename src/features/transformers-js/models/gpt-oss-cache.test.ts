// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { prepareGptOssContinuation, retainGptOssContinuation } from './gpt-oss-cache';

let runtime: typeof import('@huggingface/transformers');
const fetch = vi.fn(() => {
  throw new Error('Network forbidden in cache ownership controls');
});
beforeAll(async () => {
  vi.stubGlobal('fetch', fetch);
  const artifact = await getProductionTransformersArtifact();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
  Object.defineProperty(globalThis, 'process', { configurable: true, value: { ...process, release: { ...process.release, name: 'browser-test' } } });
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}?gpt-cache=native-prepare` }) as typeof runtime;
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor);
  }
}, 30_000);
afterAll(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

function inputs({ ids }: { ids: bigint[] }) {
  return { input_ids: new runtime.Tensor('int64', ids, [1, ids.length]), attention_mask: new runtime.Tensor('int64', ids.map(() => 1n), [1, ids.length]) };
}
function fixture() {
  const id = toToolCallId({ raw: 'actually-emitted-tool-id' });
  const messages: ChatMessage[] = [{ role: 'user', content: 'Original owned request' }];
  const assistant: ChatMessage = { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'weather', arguments: '{}' } }] };
  const next: ChatMessage[] = [...messages, assistant, { role: 'tool', tool_call_id: id, content: 'sunny' }];
  const model = { sessions: { model: { inputNames: ['input_ids', 'attention_mask'] } } };
  const config = { model_type: 'gpt_oss' };
  const baseInputs = inputs({ ids: [10n, 11n] });
  const pastKeyValues = { get_seq_length: vi.fn(() => 3) };
  const sequences = new runtime.Tensor('int64', [10n, 11n, 12n, 13n], [1, 4]);
  const retain = { owner: 'same-operation', model, config, messages, assistant, baseInputs, inputs: baseInputs, sequences, pastKeyValues, tensorClass: runtime.Tensor };
  const cache = retainGptOssContinuation(retain);
  const prepare = { cache, owner: retain.owner, model, config, messages: next,
    buildBaseInputs: vi.fn(() => baseInputs), buildSuffixInputs: vi.fn(() => inputs({ ids: [14n, 15n] })), tensorClass: runtime.Tensor };
  return { retain, prepare, pastKeyValues, sequences };
}

describe('GPT-OSS operation identity and native sequence/PKV ownership', () => {
  it('uses actual pinned native preparation to retain the unconsumed last token and full attention mask', () => {
    const value = fixture();
    const ready = prepareGptOssContinuation(value.prepare)!;
    expect(ready.inputs['input_ids']).toMatchObject({ dims: [1, 6] });
    const model = new runtime.GptOssForCausalLM(new runtime.PretrainedConfig({ model_type: 'gpt_oss' }), value.prepare.model.sessions, {});
    const actual = model.prepare_inputs_for_generation([[10n, 11n, 12n, 13n, 14n, 15n]], { ...ready.inputs, past_key_values: ready.pastKeyValues }, {});
    expect(actual.input_ids.tolist()).toEqual([[13n, 14n, 15n]]);
    expect(actual.attention_mask.tolist()).toEqual([[1n, 1n, 1n, 1n, 1n, 1n]]);
    expect(ready.pastKeyValues).toBe(value.pastKeyValues);
    expect(value.prepare.buildSuffixInputs).toHaveBeenCalledWith({ messages: value.prepare.messages.slice(1) });
  });
  it('copies actual returned sequence so later tensor mutation cannot change its prefix', () => {
    const value = fixture(); value.sequences.data[0] = 99n;
    const ready = prepareGptOssContinuation(value.prepare)!;
    expect((ready.inputs['input_ids'] as InstanceType<typeof runtime.Tensor>).tolist()).toEqual([[10n, 11n, 12n, 13n, 14n, 15n]]);
  });
  it.each([undefined, 'another-operation'])('rejects missing/different operation owner %s even with identical history', owner => {
    expect(prepareGptOssContinuation({ ...fixture().prepare, owner })).toBeUndefined();
  });
  it('rejects unowned/cache-shaped arbitrary values', () => {
    expect(prepareGptOssContinuation({ ...fixture().prepare, cache: { pastKeyValues: { get_seq_length: () => 3 } } })).toBeUndefined();
  });
  it('rejects another loaded model', () => {
    expect(prepareGptOssContinuation({ ...fixture().prepare, model: {} })).toBeUndefined();
  });
  it('rejects changed model configuration', () => {
    const value = fixture(); value.prepare.config.model_type = 'changed';
    expect(prepareGptOssContinuation(value.prepare)).toBeUndefined();
  });
  it.each(['prompt', 'system', 'assistant', 'tool-id'])('rejects changed %s in the emitted history extension', change => {
    const value = fixture(); const messages = structuredClone(value.prepare.messages);
    switch (change) {
    case 'prompt': messages[0]!.content = 'Different request'; break;
    case 'system': messages.unshift({ role: 'system', content: 'Different system' }); break;
    case 'assistant': messages[1]!.content = 'Not emitted'; break;
    case 'tool-id': messages[2]!.tool_call_id = toToolCallId({ raw: 'foreign' }); break;
    }
    expect(prepareGptOssContinuation({ ...value.prepare, messages })).toBeUndefined();
  });
  it('rejects changed tools/template tokens even when the messages still match', () => {
    expect(prepareGptOssContinuation({ ...fixture().prepare, buildBaseInputs: () => inputs({ ids: [99n, 11n] }) })).toBeUndefined();
  });
  it.each(['base', 'suffix'])('falls back when only the cached %s renderer fails', field => {
    const value = fixture();
    const throwing = () => {
      throw new Error('Synthetic optimization renderer failure');
    };
    expect(prepareGptOssContinuation({ ...value.prepare, ...(field === 'base' ? { buildBaseInputs: throwing } : { buildSuffixInputs: throwing }) })).toBeUndefined();
  });
  it.each(['AbortError', 'ProductionWorkerLifecycleError', 'RequiredDownloadedModelResourceError'])('preserves terminal %s instead of treating it as an optimization miss', name => {
    const error = new Error('Synthetic terminal error'); error.name = name;
    expect(() => prepareGptOssContinuation({ ...fixture().prepare, buildBaseInputs: () => {
      throw error;
    } })).toThrow(error);
  });
  it('refuses circular/oversized identity and plain-array tensors without a GPU readback', () => {
    const value = fixture(); const circular: { self?: unknown } = {}; circular.self = circular;
    expect(retainGptOssContinuation({ ...value.retain, config: circular })).toBeUndefined();
    expect(retainGptOssContinuation({ ...value.retain, config: { text: 'x'.repeat(262145) } })).toBeUndefined();
    expect(retainGptOssContinuation({ ...value.retain, sequences: [10n, 11n, 12n, 13n] })).toBeUndefined();
    expect(retainGptOssContinuation({ ...value.retain, owner: 1 as never })).toBeUndefined();
  });
  it.each([0, -1, 2, 4, 6, 131072, Number.NaN, Number.POSITIVE_INFINITY])('rejects stale or invalid PKV length %s before native preparation', size => {
    const value = fixture(); value.pastKeyValues.get_seq_length.mockReturnValue(size);
    expect(prepareGptOssContinuation(value.prepare)).toBeUndefined();
    expect(retainGptOssContinuation(value.retain)).toBeUndefined();
  });
  it('does not retain a terminal non-tool result or a direct call without ownership', () => {
    const value = fixture();
    expect(retainGptOssContinuation({ ...value.retain, owner: undefined })).toBeUndefined();
    expect(retainGptOssContinuation({ ...value.retain, assistant: { role: 'assistant', content: 'Done' } })).toBeUndefined();
  });
  it('rejects wrong sequence prefix and padded mask rather than normalizing them', () => {
    const value = fixture();
    value.sequences.data[0] = 99n;
    expect(retainGptOssContinuation(value.retain)).toBeUndefined();
    value.sequences.data[0] = 10n;
    value.retain.inputs.attention_mask.data[0] = 0n;
    expect(retainGptOssContinuation(value.retain)).toBeUndefined();
  });
});
