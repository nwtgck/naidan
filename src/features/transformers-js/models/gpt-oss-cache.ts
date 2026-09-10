// eslint-disable-next-line no-restricted-imports -- Worker-only native Tensor validation; no UI runtime import.
import type { Tensor } from '@huggingface/transformers';
import type { ChatMessage } from '@/01-models/types';

// Optimization ceilings, not input or generation limits. No truncation or GPU readback.
const MAX_TOKENS = 131072;
const MAX_IDENTITY_CHARS = 262144;
type Cache = Readonly<{
  owner: string; model: object; config: string; expectedHistory: string;
  baseMessages: ChatMessage[]; baseInput: BigInt64Array; sequence: BigInt64Array; pastKeyValues: object;
}>;
const ownedCaches = new WeakSet<object>();

function identity({ value }: { value: unknown }): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text !== undefined && text.length <= MAX_IDENTITY_CHARS ? text : undefined;
  } catch {
    return undefined;
  }
}

function row({ value, tensorClass }: { value: unknown; tensorClass: typeof Tensor }): BigInt64Array | undefined {
  try {
    if (!(value instanceof tensorClass) || value.location !== 'cpu' || value.type !== 'int64'
      || value.dims.length !== 2 || value.dims[0] !== 1) return undefined;
    const size = value.dims[1];
    if (!Number.isSafeInteger(size) || size! < 1 || size! > MAX_TOKENS) return undefined;
    const data = value.data;
    return data instanceof BigInt64Array && data.buffer instanceof ArrayBuffer && data.length === size ? data : undefined;
  } catch {
    return undefined;
  }
}

function inputRow({ inputs, tensorClass }: { inputs: Record<string, unknown>; tensorClass: typeof Tensor }): BigInt64Array | undefined {
  if (Object.keys(inputs).some(key => key !== 'input_ids' && key !== 'attention_mask')) return undefined;
  const ids = row({ value: inputs['input_ids'], tensorClass });
  const mask = row({ value: inputs['attention_mask'], tensorClass });
  return ids !== undefined && mask?.length === ids.length && mask.every(item => item === 1n) ? ids : undefined;
}

function renderCacheInput({ render, tensorClass }: { render: () => Record<string, unknown>; tensorClass: typeof Tensor }): BigInt64Array | undefined {
  try {
    return inputRow({ inputs: render(), tensorClass });
  } catch (error) {
    // Only the synchronous, in-memory optimization rendering is recoverable.
    // Named lifecycle/cancellation/resource errors, and all actual generation,
    // remain terminal. The current full input was already prepared successfully.
    if (error instanceof Error && ['Error', 'TypeError', 'RangeError'].includes(error.name)) return undefined;
    throw error;
  }
}

function length({ value }: { value: object }): number | undefined {
  try {
    if (!('get_seq_length' in value) || typeof value.get_seq_length !== 'function') return undefined;
    const size: unknown = value.get_seq_length();
    return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size < MAX_TOKENS ? size : undefined;
  } catch {
    return undefined;
  }
}

export function retainGptOssContinuation({ owner, model, config, messages, assistant, baseInputs, inputs, sequences, pastKeyValues, tensorClass }: {
  owner: string | undefined; model: object; config: unknown; messages: ChatMessage[]; assistant: ChatMessage;
  baseInputs: Record<string, unknown>; inputs: Record<string, unknown>; sequences: unknown; pastKeyValues: unknown; tensorClass: typeof Tensor;
}): Cache | undefined {
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > 128 || !assistant.tool_calls?.length) return undefined;
  const expectedHistory = identity({ value: [...messages, assistant] });
  const configIdentity = identity({ value: config });
  const base = inputRow({ inputs: baseInputs, tensorClass });
  const input = inputRow({ inputs, tensorClass });
  const sequence = row({ value: sequences, tensorClass });
  if (expectedHistory === undefined || configIdentity === undefined || base === undefined || input === undefined || sequence === undefined
    || sequence.length <= input.length || !input.every((item, index) => sequence[index] === item)
    || typeof pastKeyValues !== 'object' || pastKeyValues === null || length({ value: pastKeyValues }) !== sequence.length - 1) return undefined;
  const cache = Object.freeze({ owner, model, config: configIdentity, expectedHistory,
    baseMessages: structuredClone(messages), baseInput: new BigInt64Array(base), sequence: new BigInt64Array(sequence), pastKeyValues });
  ownedCaches.add(cache);
  return cache;
}

export function prepareGptOssContinuation({ cache, owner, model, config, messages, buildBaseInputs, buildSuffixInputs, tensorClass }: {
  cache: unknown; owner: string | undefined; model: object; config: unknown; messages: ChatMessage[];
  buildBaseInputs: ({ messages }: { messages: ChatMessage[] }) => Record<string, unknown>;
  buildSuffixInputs: ({ messages }: { messages: ChatMessage[] }) => Record<string, unknown>;
  tensorClass: typeof Tensor;
}): { inputs: Record<string, unknown>; pastKeyValues: object } | undefined {
  if (typeof cache !== 'object' || cache === null || !ownedCaches.has(cache)) return undefined;
  const owned = cache as Cache;
  if (typeof owner !== 'string' || owned.owner !== owner || owned.model !== model || owned.config !== identity({ value: config })) return undefined;
  const assistantIndex = owned.baseMessages.length;
  if (messages.length <= assistantIndex + 1 || owned.expectedHistory !== identity({ value: messages.slice(0, assistantIndex + 1) })) return undefined;
  const assistant = messages[assistantIndex]!;
  const results = messages.slice(assistantIndex + 1);
  const ids = assistant.tool_calls?.map(call => call.id);
  if (ids === undefined || ids.length !== results.length || new Set(ids).size !== ids.length
    || results.some((message, index) => message.role !== 'tool' || message.tool_call_id !== ids[index])) return undefined;
  const base = renderCacheInput({ render: () => buildBaseInputs({ messages: owned.baseMessages }), tensorClass });
  if (base === undefined || base.length !== owned.baseInput.length || !base.every((item, index) => owned.baseInput[index] === item)) return undefined;
  const suffix = renderCacheInput({ render: () => buildSuffixInputs({ messages: [assistant, ...results] }), tensorClass });
  if (suffix === undefined || owned.sequence.length + suffix.length > MAX_TOKENS || length({ value: owned.pastKeyValues }) !== owned.sequence.length - 1) return undefined;
  const data = new BigInt64Array(owned.sequence.length + suffix.length);
  data.set(owned.sequence); data.set(suffix, owned.sequence.length);
  // Full input/mask lets the pinned decoder prepare slice at actual PKV length,
  // preserving the final generated token that the last forward did not consume.
  return { inputs: {
    input_ids: new tensorClass('int64', data, [1, data.length]),
    attention_mask: new tensorClass('int64', new BigInt64Array(data.length).fill(1n), [1, data.length]),
  }, pastKeyValues: owned.pastKeyValues };
}

export const TEST_ONLY = {
};
