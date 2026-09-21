// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { generateProductionProviderCapture } from './production-provider-capture-generation';
import { captureScenarioInput, captureProviderMessages, captureSettledAssistantParts } from './production-provider-capture-plan';
import { createProductionProviderPartsTrace } from './production-provider-trace';

const limits = { maximumEvents: 100, maximumCharacters: 10000 };
const done: ChatGenerationItem = { type: 'result', result: { type: 'finished', next: 'user' } };
const limited: ChatGenerationItem = { type: 'result', result: { type: 'interrupted', reason: 'limit' } };
function text({ type, partId, index, chunks, completeness }: {
  type: 'text' | 'reasoning'; partId: string; index: number; chunks: string[]; completeness: 'complete' | 'partial';
}): ChatGenerationItem {
  return { type, partId, index, chunks: (async function* () {
    yield* chunks;
  })(), completeness: Promise.resolve(completeness) };
}
function fixture({ chat }: { chat: LmProvider['chat'] }) {
  let owned = false;
  const calls = vi.fn<LmProvider['chat']>(args => {
    expect(owned).toBe(true);
    return chat(args);
  });
  const operation = vi.fn<NonNullable<LmProvider['runChatOperation']>>(async ({ signal, operation }) => {
    if (!signal) throw new Error('Expected explicit capture signal');
    owned = true;
    try {
      await operation({ chat: calls, signal });
    } finally {
      owned = false;
    }
  });
  const provider: LmProvider = { chat: () => {
    throw new Error('Must use the owned production operation');
  },
  runChatOperation: operation, listModels: async () => [] };
  return { provider, calls, operation };
}
function trace() {
  return createProductionProviderPartsTrace({ requestId: 'capture-first-turn', limits });
}
function message({ parts }: { parts: AssistantMessageNode['parts'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'observed' }), role: 'assistant', createdAt: 0, modelId: undefined,
    lmParameters: undefined, parts, interruption: undefined, replies: { items: [] } };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => {
  throw new Error('Capture tests forbid network');
})));
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

// The common operation, parts consumer, snapshots and fixed tool are real.
// Provider generation is synthetic, not recorded model inference or native KV evidence.
describe('production capture using the parts generation contract', () => {
  it('keeps reasoning and literal tagged text in their own parts for the next fixed user request', async () => {
    const f = fixture({ chat: () => (async function* () {
      yield text({ type: 'reasoning', partId: 'r', index: 0, chunks: ['  R', '\n'], completeness: 'complete' });
      yield text({ type: 'text', partId: 't', index: 1, chunks: ['<thi', 'nk>literal</think>🙂\r\n'], completeness: 'partial' });
      yield limited;
    })() });
    const recorded = trace();
    const result = await generateProductionProviderCapture({ provider: f.provider, modelId: 'fixture/model', input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), abortController: new AbortController(), trace: recorded });
    expect(result).toEqual(limited.result);
    expect(f.operation).toHaveBeenCalledOnce(); expect(f.calls).toHaveBeenCalledOnce();
    const settled = recorded.settle({ outcome: 'fulfilled', error: undefined });
    expect(captureSettledAssistantParts({ settled })).toEqual([
      { id: 'r', type: 'reasoning', text: '  R\n', completeness: 'complete' },
      { id: 't', type: 'text', text: '<think>literal</think>🙂\r\n', completeness: 'partial' },
    ]);
    const next = captureScenarioInput({ scenario: 'continuity', firstSettled: settled });
    const history = captureProviderMessages({ input: next });
    expect(history[1]).toMatchObject({ role: 'assistant', parts: captureSettledAssistantParts({ settled }) });
    expect(history[2]).toMatchObject({ role: 'user', parts: [{ text: 'Continue the synthetic conversation with a short response.' }] });
    const first = history[1]?.parts[0];
    if (first?.type !== 'reasoning') throw new Error('Expected reasoning part');
    first.text = 'mutated caller copy';
    expect(captureProviderMessages({ input: next })[1]?.parts[0]).toMatchObject({ text: '  R\n' });
    expect(recorded.snapshot().events.some(event => ['chunk', 'assistant-start', 'tool-call'].includes(event.kind))).toBe(false);
  });

  it('executes the fixed tool and reinserts the exact parts using a single owned operation', async () => {
    let count = 0;
    const f = fixture({ chat: () => (async function* () {
      if (count++ === 0) {
        yield text({ type: 'reasoning', partId: 'r', index: 0, chunks: ['R\n'], completeness: 'complete' });
        yield { type: 'tool_call', partId: 'c', index: 1, toolCall: { id: toToolCallId({ raw: 'call-fixed' }), type: 'function', function: { name: 'lookup_weather', arguments: ' {"city":"Tokyo"} ' } } };
        yield { type: 'result', result: { type: 'finished', next: 'tool_results' } };
      } else {
        yield text({ type: 'text', partId: 'answer', index: 0, chunks: ['20°C'], completeness: 'complete' }); yield done;
      }
    })() });
    const recorded = trace();
    await generateProductionProviderCapture({ provider: f.provider, modelId: 'fixture/model', input: captureScenarioInput({ scenario: 'natural-tool-minimal', firstSettled: undefined }), abortController: new AbortController(), trace: recorded });
    expect(f.operation).toHaveBeenCalledOnce(); expect(f.calls).toHaveBeenCalledTimes(2);
    expect(f.calls.mock.calls[1]?.[0].messages).toEqual([
      { id: 'capture_input_0', role: 'user', parts: [{ id: 'text_0', type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' }] },
      { id: 'capture_assistant_0', role: 'assistant', parts: [
        { id: 'r', type: 'reasoning', text: 'R\n', completeness: 'complete' },
        { id: 'c', type: 'tool_call', toolCall: { id: 'call-fixed', type: 'function', function: { name: 'lookup_weather', arguments: ' {"city":"Tokyo"} ' } } },
      ] },
      { id: 'capture_tool_1', role: 'tool', parts: [{ id: 'tool_result_0', type: 'tool_result', result: { toolCallId: 'call-fixed', status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' } } }] },
    ]);
    expect(recorded.snapshot().events.filter(event => event.kind === 'tool-success')).toHaveLength(1);
    const settled = recorded.settle({ outcome: 'fulfilled', error: undefined });
    expect(captureSettledAssistantParts({ settled })).toEqual([{ id: 'answer', type: 'text', text: '20°C', completeness: 'complete' }]);
  });

  it('keeps observed partial content on a thrown generation error but omits its private message', async () => {
    const error = Object.assign(new Error('/private/path SECRET'), { name: 'SyntaxError' });
    const recorded = trace();
    const f = fixture({ chat: () => (async function* () {
      yield text({ type: 'text', partId: 't', index: 0, chunks: ['received'], completeness: 'partial' });
      await vi.waitFor(() => expect(recorded.snapshot().events).toContainEqual(expect.objectContaining({ kind: 'part_text', text: 'received' })));
      throw error;
    })() });
    await expect(generateProductionProviderCapture({ provider: f.provider, modelId: 'fixture/model', input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), abortController: new AbortController(), trace: recorded })).rejects.toBe(error);
    const settled = recorded.settle({ outcome: 'rejected', error });
    expect(captureSettledAssistantParts({ settled })).toEqual([{ id: 't', type: 'text', text: 'received', completeness: 'partial' }]);
    expect(recorded.snapshot().events).toContainEqual(expect.objectContaining({ kind: 'generation_error', errorName: 'SyntaxError' }));
    expect(JSON.stringify(recorded.snapshot())).not.toMatch(/private|SECRET/u);
  });

  it('materializes the existing image as a memory Blob and passes no binary fetch capability', async () => {
    const f = fixture({ chat: () => (async function* () {
      yield done;
    })() });
    await generateProductionProviderCapture({ provider: f.provider, modelId: 'fixture/model', input: captureScenarioInput({ scenario: 'image', firstSettled: undefined }), abortController: new AbortController(), trace: trace() });
    const call = f.calls.mock.calls[0]?.[0];
    expect(call?.readBinaryObject).toBeUndefined(); expect(call?.parameters?.maxCompletionTokens).toBe(1);
    const image = call?.messages[0]?.parts[1];
    if (image?.type !== 'attachment' || image.attachment.status !== 'memory') throw new Error('Expected local image');
    expect(image.attachment.blob.size).toBe(68); expect(image.attachment.blob.type).toBe('image/png');
  });

  it('does not conflate empty parts, absent text, or adjacent same-kind part boundaries', () => {
    const recorded = trace();
    const parts: AssistantMessageNode['parts'] = [
      { id: 'r1', type: 'reasoning', text: '', completeness: 'complete' },
      { id: 'r2', type: 'reasoning', text: 'R', completeness: 'complete' },
      { id: 't', type: 'text', text: '', completeness: 'partial' },
    ];
    recorded.observeAssistant({ message: message({ parts }) });
    recorded.observeResult({ result: { type: 'interrupted', reason: 'limit' } });
    const settled = recorded.settle({ outcome: 'fulfilled', error: undefined });
    const before = JSON.stringify(settled);
    parts[1] = { id: 'r2', type: 'reasoning', text: 'late change', completeness: 'complete' };
    recorded.observeAssistant({ message: message({ parts }) });
    expect(JSON.stringify(settled)).toBe(before);
    expect(captureSettledAssistantParts({ settled })).toEqual([
      { id: 'r1', type: 'reasoning', text: '', completeness: 'complete' },
      { id: 'r2', type: 'reasoning', text: 'R', completeness: 'complete' },
      { id: 't', type: 'text', text: '', completeness: 'partial' },
    ]);
    expect(recorded.snapshot().lateEvents.length).toBeGreaterThan(0);
  });

  it('uses logical applied order when a later-declared part is inserted before another', () => {
    const recorded = trace();
    const later: AssistantMessageNode['parts'][number] = { id: 'later', type: 'text', text: 'B', completeness: 'partial' };
    recorded.observeAssistant({ message: message({ parts: [later] }) });
    const earlier: AssistantMessageNode['parts'][number] = { id: 'earlier', type: 'reasoning', text: 'A', completeness: 'complete' };
    recorded.observeAssistant({ message: message({ parts: [earlier, { ...later, completeness: 'complete' }] }) });
    recorded.observeResult({ result: { type: 'finished', next: 'user' } });
    const settled = recorded.settle({ outcome: 'fulfilled', error: undefined });
    expect(captureSettledAssistantParts({ settled })?.map(part => part.id)).toEqual(['earlier', 'later']);
  });

  it('marks an over-budget observation incomplete without controlling production generation', async () => {
    const f = fixture({ chat: () => (async function* () {
      yield text({ type: 'text', partId: 't', index: 0, chunks: ['long captured content'], completeness: 'complete' }); yield done;
    })() });
    const recorded = createProductionProviderPartsTrace({ requestId: 'tiny', limits: { maximumEvents: 1, maximumCharacters: 1 } });
    expect(await generateProductionProviderCapture({ provider: f.provider, modelId: 'fixture/model', input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), abortController: new AbortController(), trace: recorded })).toEqual(done.result);
    const settled = recorded.settle({ outcome: 'fulfilled', error: undefined });
    expect(settled.completeness).toBe('incomplete');
    expect(() => captureScenarioInput({ scenario: 'continuity', firstSettled: settled })).toThrow('complete first settlement');
  });
});
