import { expect, it, vi } from 'vitest';
import { prepareTranscript } from './chat-wire';
import { peerDocumentLimits } from '@/features/naidan-peer-rpc/contract';
import { bytesSource, collectBytes, decodeDocument, encodeDocument } from './transfer';

it('rejects deeply nested byte documents before recursive schema parsing', () => {
  const text = '{"child":'.repeat(256) + 'null' + '}'.repeat(256);
  expect(() => decodeDocument({ bytes: new TextEncoder().encode(text) })).toThrow('depth');
});
it('rejects excessive document nodes even inside the byte budget', () => {
  const text = '[' + '0,'.repeat(65536) + '0]';
  expect(() => decodeDocument({ bytes: new TextEncoder().encode(text) })).toThrow('node');
});
it('applies the same structural bound before encoding an outbound document', () => {
  let value: unknown = undefined;
  for (let index = 0; index < 256; index++) value = { child: value };
  expect(() => encodeDocument({ value, limit: 1024 * 1024 })).toThrow('depth');
});
it('keeps ordinary JSON tool schemas, null values, Unicode and optional omission', () => {
  const value = { parameters: { type: 'object', properties: { text: { type: 'string', example: null } } }, prompt: '風景 🌄', optional: undefined };
  expect(decodeDocument({ bytes: encodeDocument({ value, limit: 1024 }) })).toEqual({ parameters: value.parameters, prompt: value.prompt });
});
it('treats a long string as one node rather than nesting or delimiters', () => {
  const value = { prompt: '[{"value":null}]'.repeat(4096) };
  expect(decodeDocument({ bytes: encodeDocument({ value, limit: 128 * 1024 }) })).toEqual(value);
});
it('rejects a non-byte chunk rather than silently dropping it', async () => {
  const cancel = vi.fn();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
    controller.enqueue('not bytes' as unknown as Uint8Array);
  },
    cancel,
  });
  await expect(collectBytes({ readable, limit: 32, signal: new AbortController().signal })).rejects.toThrow('byte');
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([NaN, Infinity, -1, 1.5])('rejects an invalid collection budget %s without locking the source', async limit => {
  const readable = bytesSource({ bytes: new Uint8Array([1, 2]) });
  await expect(collectBytes({ readable, limit, signal: new AbortController().signal })).rejects.toThrow('limit');
  expect(readable.locked).toBe(false);
});

it('accepts the declared maximum depth and rejects the next nested value', () => {
  let value: unknown = null;
  for (let depth = 0; depth < peerDocumentLimits.depth; depth++) value = { child: value };
  const bytes = encodeDocument({ value, limit: 4096 });
  expect(decodeDocument({ bytes })).toEqual(value);
  expect(() => encodeDocument({ value: { child: value }, limit: 4096 })).toThrow('depth');
});
it('counts the root in the node limit and accepts the exact limit', () => {
  const value = Array(peerDocumentLimits.nodes - 1).fill(0);
  const bytes = encodeDocument({ value, limit: 1024 * 1024 });
  expect(decodeDocument({ bytes })).toEqual(value);
  expect(() => encodeDocument({ value: [...value, 0], limit: 1024 * 1024 })).toThrow('node');
});

it('bounds a local tool schema before recursive Zod validation, including cyclic input', () => {
  const input = {
    model: 'local/model',
    messages: [{
    role: 'user' as const,
    content: 'hello',
    reasoning_content: undefined,
    tool_calls: undefined,
    tool_call_id: undefined,
    name: undefined,
  }],
    tools: undefined,
  temperature: 0.7,
    topP: 0.9,
    maxTokens: 10,
    reasoningEffort: undefined,
    presencePenalty: 0,
    frequencyPenalty: 0,
    stop: [],
    debug: undefined,
  };
  const parameters: NonNullable<Parameters<typeof prepareTranscript>[0]['input']['tools']>[number]['function']['parameters'] = {}; parameters.child = parameters;
  expect(() => prepareTranscript({ input: { ...input, tools: [{ type: 'function', function: { name: 'tool', description: '', parameters } }] } })).toThrow('depth');
});
