import { describe, expect, it, vi } from 'vitest';
import type { LmProvider, ChatGenerationItem } from '@/01-models/lm';
import type { WorkflowGenerationInput } from './runtime';
import { generateWorkflowText } from './generation';
import { createOutputStoreFixture } from './output-store.test-support';
import { baseStep } from './workflow.test-support';
import { readText, releaseValues, WORKFLOW_INPUT_LIMIT } from './values';

function fixture() {
  const outputs = createOutputStoreFixture({ limits: { maxBytes: 4 * 1024 * 1024, maxOutputBytes: 2 * 1024 * 1024, maxEntries: 32, maxPendingWriteBytes: 131072, maxWriteChunkBytes: 32768 } });
  const step = baseStep({ type: 'text_generation', id: 'generation' });
  if (step.type !== 'text_generation') {
    throw new Error('fixture');
  }
  const controller = new AbortController();
  const input: WorkflowGenerationInput = { step, target: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: 'test' }, conversation: [{ role: 'user', parts: [{ type: 'json', value: 'question' }] }], signal: controller.signal, store: outputs.store };
  return {
    input,
    outputs,
    controller,
    async [Symbol.asyncDispose]() {
      await outputs[Symbol.asyncDispose]();
    },
  };
}

function part({ type, index, chunks, completeness }: { type: 'text' | 'reasoning', index: number, chunks: string[], completeness: Promise<'complete' | 'partial'> }): ChatGenerationItem {
  return {
    type,
    index,
    partId: `${type}-${index}`,
    chunks: (async function* () {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    })(),
    completeness,
  };
}

function provider({ items }: { items: ChatGenerationItem[] }): LmProvider {
  return {
    chat: vi.fn(async function* () {
      yield* items;
    }),
    listModels: vi.fn(async () => ['test']),
  };
}

describe('Workflow model adapter', () => {
  it('spools interleaved parts and preserves their logical order and independent conversation lease', async () => {
    await using test = fixture();
    const lm = provider({ items: [part({ type: 'text', index: 2, chunks: ['B'], completeness: Promise.resolve('complete') }), part({ type: 'reasoning', index: 1, chunks: ['think'], completeness: Promise.resolve('complete') }), part({ type: 'text', index: 0, chunks: ['A'], completeness: Promise.resolve('complete') }), { type: 'result', result: { type: 'finished', next: 'user' } }] });
    const result = await generateWorkflowText({ input: test.input, provider: lm });
    expect(await readText({ value: result.text!, maxBytes: 100, signal: undefined })).toBe('AB');
    expect(await readText({ value: result.reasoning!, maxBytes: 100, signal: undefined })).toBe('think');
    const conversation = result.conversation!;
    if (conversation.type !== 'conversation') {
      throw new Error('fixture');
    }
    expect(conversation.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    await releaseValues({ values: [result.text!, result.reasoning!, result.metrics!] });
    expect(await readText({ value: conversation.messages[1]!.parts[0]!, maxBytes: 100, signal: undefined })).toBe('AB');
    await releaseValues({ values: [conversation] });
    expect(test.outputs.store.getUsage().entries).toBe(0);
  });

  it('uses the provider operation owner and snapshots effective system instructions', async () => {
    await using test = fixture();
    test.input.step.systemPrompt = { behavior: 'override', content: 'new system' };
    test.input.conversation.unshift({ role: 'system', parts: [{ type: 'json', value: 'old system' }] });
    const lm = provider({ items: [{ type: 'result', result: { type: 'finished', next: 'user' } }] });
    const operation = vi.fn<NonNullable<LmProvider['runChatOperation']>>(async ({ signal, operation }) => operation({ chat: lm.chat, signal: signal ?? new AbortController().signal }));
    lm.runChatOperation = operation;
    const result = await generateWorkflowText({ input: test.input, provider: lm });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(result.conversation).toMatchObject({
      type: 'conversation',
      messages: [
        { role: 'system', parts: [{ type: 'json', value: 'new system' }] },
        { role: 'user' }, { role: 'assistant' },
      ],
    });
    expect(lm.chat).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined, messages: [expect.objectContaining({ role: 'system', parts: [expect.objectContaining({ text: 'new system' })] }), expect.objectContaining({ role: 'user' })] }));
    await releaseValues({ values: Object.values(result) });
  });

  it.each(['assistant', 'system'] as const)('rejects an initial generation ending in %s', async role => {
    await using test = fixture();
    test.input.conversation[0]!.role = role;
    const lm = provider({ items: [] });
    await expect(generateWorkflowText({ input: test.input, provider: lm })).rejects.toThrow('end with a user');
    expect(lm.chat).not.toHaveBeenCalled();
  });

  it('rejects unsupported tool requests without publishing a partial result', async () => {
    await using test = fixture();
    const lm = provider({ items: [part({ type: 'text', index: 0, chunks: ['partial'], completeness: Promise.resolve('complete') }), { type: 'tool_call_draft', partId: 'tool', index: 1, name: 'shell_execute', arguments: undefined }] });
    await expect(generateWorkflowText({ input: test.input, provider: lm })).rejects.toThrow('authority');
    expect(test.outputs.store.getUsage().entries).toBe(0);
  });

  it.each(['partial', 'reject'] as const)('cleans generated parts after %s completeness', async mode => {
    await using test = fixture();
    const completion = Promise.withResolvers<'complete' | 'partial'>();
    const lm: LmProvider = {
      async *chat() {
        yield part({ type: 'text', index: 0, chunks: ['data'], completeness: completion.promise });
        if (mode === 'partial') {
          completion.resolve('partial');
        } else {
          completion.reject(new Error('completeness failed'));
        }
        yield { type: 'result', result: { type: 'finished', next: 'user' } };
      },
      async listModels() {
        return [];
      },
    };
    await expect(generateWorkflowText({ input: test.input, provider: lm })).rejects.toThrow();
    expect(test.outputs.store.getUsage().entries).toBe(0);
  });

  it.each([-1, NaN, 1.5])('rejects an invalid logical part index %s', async index => {
    await using test = fixture();
    await expect(generateWorkflowText({ input: test.input, provider: provider({ items: [part({ type: 'text', index, chunks: [], completeness: Promise.resolve('complete') })] }) })).rejects.toThrow('Invalid');
  });

  it('counts system instructions against the bounded request budget', async () => {
    await using test = fixture();
    test.input.step.systemPrompt = { behavior: 'append', content: 'x'.repeat(WORKFLOW_INPUT_LIMIT) };
    const lm = provider({ items: [] });
    await expect(generateWorkflowText({ input: test.input, provider: lm })).rejects.toThrow('limit');
    expect(lm.chat).not.toHaveBeenCalled();
  });

  it('rejects enabled tools before invoking a provider', async () => {
    await using test = fixture();
    test.input.step.toolConfigs = [{ key: 'builtin.calculator', status: 'enabled' }];
    const lm = provider({ items: [] });
    await expect(generateWorkflowText({ input: test.input, provider: lm })).rejects.toThrow('tools');
    expect(lm.chat).not.toHaveBeenCalled();
  });

  it('requires an explicit successful provider completion', async () => {
    await using test = fixture();
    await expect(generateWorkflowText({ input: test.input, provider: provider({ items: [] }) })).rejects.toThrow('completion');
  });
});
