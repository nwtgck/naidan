import { describe, it, expect, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import type { LmProvider, ChatGenerationItem } from '@/01-models/lm';
import { materializeWorkflowConversation } from './conversation';
import { readText } from './values';
import { modelToolsFixture, modelCall, modelText } from './model-tools.test-support';

const done = { type: 'result', result: { type: 'finished', next: 'user' } } as const;
const toolsDone = { type: 'result', result: { type: 'finished', next: 'tool_results' } } as const;
const calculator = [{ key: 'builtin.calculator', status: 'enabled' }] as const;

function provider({ rounds }: { rounds: ChatGenerationItem[][] }): LmProvider {
  let index = 0;
  const lm: LmProvider = {
    chat: vi.fn(async function* () {
      yield* rounds[index++] ?? [];
    }),
    listModels: vi.fn(async () => []),
    runChatOperation: vi.fn(async ({ operation, signal }) => operation({ chat: lm.chat, signal: signal ?? new AbortController().signal })),
  };
  return lm;
}

describe('model-selected Workflow tools', () => {
  it('owns all model rounds once and preserves exact arguments, reasoning and paired results', async () => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    const call = modelCall({ id: 'a', name: 'calculator', args: '{ "expression": "1 + 1" }', index: 1 });
    const lm = provider({
      rounds: [
        [{
          type: 'reasoning',
          index: 0,
          partId: 'thinking',
          chunks: (async function* () {
            yield 'think';
          })(),
          completeness: Promise.resolve('complete'),
        }, call, toolsDone],
        [modelText({ text: 'answer' }), done],
      ],
    });
    const outputs = await test.generate({ provider: lm });
    expect(lm.runChatOperation).toHaveBeenCalledTimes(1);
    expect(lm.chat).toHaveBeenCalledTimes(2);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.authorize).not.toHaveBeenCalled();
    expect(await readText({ value: outputs.text!, maxBytes: 100, signal: undefined })).toBe('answer');
    expect(await readText({ value: outputs.reasoning!, maxBytes: 100, signal: undefined })).toBe('think');
    expect(outputs.metrics).toMatchObject({ value: { rounds: 2, toolCalls: 1 } });
    if (outputs.conversation?.type !== 'conversation') {
      throw new Error('Expected conversation');
    }
    const copied = await materializeWorkflowConversation({ messages: outputs.conversation.messages, signal: test.input.signal });
    expect(copied.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(copied.messages[1]).toMatchObject({ parts: [{ type: 'reasoning', text: 'think' }, { type: 'tool_call', toolCall: { function: { arguments: '{ "expression": "1 + 1" }' } } }] });
    expect(copied.messages[2]).toMatchObject({ parts: [{ result: { status: 'success', content: { text: '2' } } }] });
  });

  it('returns invalid arguments to the model without executing them', async () => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    const lm = provider({
      rounds: [
        [modelCall({ id: 'bad', name: 'calculator', args: '{bad', index: 0 }), toolsDone],
        [modelText({ text: 'corrected' }), done],
      ],
    });
    await test.generate({ provider: lm });
    expect(test.execute).not.toHaveBeenCalled();
    expect(lm.chat).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', parts: [expect.objectContaining({ result: expect.objectContaining({ status: 'error', error: expect.objectContaining({ code: 'invalid_arguments' }) }) })] })]),
    }));
  });

  it.each(['denied', 'cancelled'] as const)('does not resume inference after %s approval', async kind => {
    await using test = modelToolsFixture({ configs: [{ key: 'builtin.wikipedia', status: 'enabled' }] });
    test.authorize.mockImplementation(async () => {
      if (kind === 'cancelled') {
        test.controller.abort();
      }
      return false;
    });
    const lm = provider({ rounds: [[modelCall({ id: 'wiki', name: 'wikipedia_search', args: '{"lang":"en","query":"a"}', index: 0 }), toolsDone], [done]] });
    await expect(test.generate({ provider: lm })).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalled();
    expect(lm.chat).toHaveBeenCalledTimes(1);
    expect(test.store.getUsage().entries).toBe(0);
  });

  it('reviews identical external requests separately and runs them sequentially', async () => {
    await using test = modelToolsFixture({ configs: [{ key: 'builtin.wikipedia', status: 'enabled' }] });
    const order: string[] = [];
    test.authorize.mockImplementation(async () => {
      order.push('review');
      return true;
    });
    test.execute.mockImplementation(async () => {
      order.push('execute');
      return { outcome: { status: 'success', content: 'ok' }, metadata: {} };
    });
    await test.generate({
      provider: provider({
        rounds: [
          [...['a', 'b'].map((id, index) => modelCall({ id, index, name: 'wikipedia_search', args: '{"lang":"en","query":"same"}' })), toolsDone],
          [done],
        ],
      }),
    });
    expect(order).toEqual(['review', 'execute', 'review', 'execute']);
  });

  it.each(['rounds', 'calls'] as const)('checks the %s budget before side effects in a batch', async limit => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    test.input.step.toolExecution = { maxRounds: limit === 'rounds' ? 1 : 8, maxCalls: 1, shell: undefined };
    const lm = provider({
      rounds: [[
        modelCall({ id: 'a', name: 'calculator', args: '{"expression":"1"}', index: 0 }),
        modelCall({ id: 'b', name: 'calculator', args: '{"expression":"2"}', index: 1 }), toolsDone,
      ]],
    });
    await expect(test.generate({ provider: lm })).rejects.toThrow('limit');
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each(['messages', 'bytes'] as const)('checks known %s context capacity before any tool in a batch', async boundary => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    test.input.conversation = boundary === 'messages'
      ? Array.from({ length: 255 }, () => ({ role: 'user' as const, parts: [{ type: 'json' as const, value: '' }] }))
      : [{ role: 'user', parts: [{ type: 'json', value: 'x'.repeat(2 * 1024 * 1024 - 8) }] }];
    const lm = provider({ rounds: [[modelCall({ id: 'new', name: 'calculator', args: '{"expression":"1"}', index: 0 }), toolsDone]] });
    await expect(test.generate({ provider: lm })).rejects.toThrow(boundary === 'messages' ? '256 messages' : 'materialization limit');
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.authorize).not.toHaveBeenCalled();
    expect(test.store.getUsage().entries).toBe(0);
  });

  it('never dispatches an unadvertised tool', async () => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    await expect(test.generate({ provider: provider({ rounds: [[modelCall({ id: 'a', name: 'shell_execute', args: '{}', index: 0 }), toolsDone]] }) })).rejects.toThrow('authority');
    expect(test.execute).not.toHaveBeenCalled();
  });

  it('waits for a cancelled executing tool and publishes no delayed result', async () => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    const gate = Promise.withResolvers<void>();
    using gateOwner = {
      gate,
      [Symbol.dispose]() {
        gate.resolve();
      },
    };
    test.execute.mockImplementation(async () => {
      await gate.promise;
      return { outcome: { status: 'success', content: 'late' }, metadata: {} };
    });
    const lm = provider({ rounds: [[modelCall({ id: 'a', name: 'calculator', args: '{"expression":"1"}', index: 0 }), toolsDone], [done]] });
    let settled = false;
    const pending = test.generate({ provider: lm }).then(() => {
      settled = true;
    }, error => {
      settled = true;
      throw error;
    });
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
    test.controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    gateOwner.gate.resolve();
    await assertion;
    expect(lm.chat).toHaveBeenCalledTimes(1);
    expect(test.store.getUsage().entries).toBe(0);
  });

  it('aborts and drains open text when the provider iterator throws', async () => {
    await using test = modelToolsFixture({ configs: [] });
    let drained = false;
    const started = Promise.withResolvers<void>();
    const lm: LmProvider = {
      listModels: async () => [],
      async *chat({ signal }) {
        const aborted = Promise.withResolvers<void>();
        signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        yield {
          type: 'text',
          index: 0,
          partId: 'text',
          completeness: Promise.resolve('complete'),
          chunks: (async function* () {
            started.resolve();
            await aborted.promise;
            drained = true;
            yield 'late';
          })(),
        };
        await started.promise;
        throw new Error('provider failed');
      },
    };
    await expect(test.generate({ provider: lm })).rejects.toThrow('provider failed');
    expect(drained).toBe(true);
    expect(test.store.getUsage().entries).toBe(0);
  });

  it.each(['duplicate-call', 'unanswered', 'same-draft-position'] as const)('rejects %s protocol violations', async mode => {
    await using test = modelToolsFixture({ configs: [...calculator] });
    const call = modelCall({ id: 'a', name: 'calculator', args: '{"expression":"1"}', index: 0 });
    const items: ChatGenerationItem[] = mode === 'duplicate-call'
      ? [call, { ...modelCall({ id: 'a', name: 'calculator', args: '{}', index: 1 }), partId: 'b' }, toolsDone]
      : mode === 'unanswered'
        ? [call, done]
        : [{ type: 'tool_call_draft', partId: 'a', index: 0, name: 'calculator', arguments: undefined }, { type: 'tool_call_draft', partId: 'b', index: 0, name: 'calculator', arguments: undefined }, toolsDone];
    await expect(test.generate({ provider: provider({ rounds: [items] }) })).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it('binds the shell to an explicit folder and rejects sysfs inheritance', async () => {
    await using test = modelToolsFixture({ configs: [{ key: 'builtin.wesh', status: 'enabled', naidanSysfs: { accessScope: 'none' } }] });
    expect(() => test.tools()).toThrow('explicit folder');
    test.input.step.toolExecution = { maxRounds: 8, maxCalls: 16, shell: { volumeId: toVolumeId({ raw: 'only-folder' }), access: 'read-only' } };
    const tools = test.tools();
    const call = modelCall({ id: 'a', name: 'shell_execute', args: '{"shell_script":"pwd"}', index: 0 });
    if (call.type !== 'tool_call') {
      throw new Error('fixture');
    }
    await tools.execute({ call: call.toolCall, signal: test.input.signal });
    expect(test.authorize).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ volumeId: 'only-folder', access: 'read-only' }) }));
  });

  it('round-trips one human choice and never invokes an external executor', async () => {
    await using test = modelToolsFixture({ configs: [{ key: 'builtin.choices', status: 'enabled' }] });
    const call = modelCall({ id: 'a', name: 'choices', args: '{"prompt":"Pick","choices":["one","two"]}', index: 0 });
    if (call.type !== 'tool_call') {
      throw new Error('fixture');
    }
    const result = await test.tools().execute({ call: call.toolCall, signal: test.input.signal });
    expect(result).toMatchObject({ status: 'success' });
    expect(JSON.stringify(result)).toContain('two');
    expect(test.requestChoice).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Pick', choices: ['one', 'two'] }));
    expect(test.execute).not.toHaveBeenCalled();
  });
});

export const TEST_ONLY = {
};
