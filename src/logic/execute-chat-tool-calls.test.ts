import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reactive, watch } from 'vue';
import { executeChatToolCalls } from './execute-chat-tool-calls';
import type { Tool, TextOrBinaryObject } from '@/01-models/tool';
import type { ToolMessageNode, ToolCall } from '@/01-models/types';
import type { ToolApprovalContext } from '@/01-models/tool-approval';
import { toMessageId, toToolCallId, toBinaryObjectId, toChatId } from '@/01-models/ids';

function fresh(): ToolMessageNode {
  return { id: toMessageId({ raw: 'tool-node' }), role: 'tool', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
}
function call({ id, name, argumentsText }: { id: string, name: string, argumentsText: string }): ToolCall {
  return { id: toToolCallId({ raw: id }), type: 'function', function: { name, arguments: argumentsText } };
}
function tool({ execute }: { execute: Tool['execute'] }): Tool {
  return { name: 'f', description: 'Fixture function', parametersSchema: z.object({ n: z.number().default(4) }), execute };
}
async function inline({ text }: { text: string }): Promise<TextOrBinaryObject> {
  return { type: 'text', text };
}
function execute({ calls, tools, node, signal, persistContent, onChange }: {
  calls: ToolCall[], tools: Tool[], node: ToolMessageNode, signal: AbortSignal | undefined,
  persistContent: Parameters<typeof executeChatToolCalls>[0]['persistContent'], onChange: () => void | Promise<void>,
}) {
  return executeChatToolCalls({ calls, tools, node, signal, persistContent, onChange, approvalContext: undefined, onEvent: () => {} });
}

describe('completed tool call execution', () => {
  it('executes validated defaults but keeps historical arguments unchanged', async () => {
    const completed = call({ id: 'call', name: 'f', argumentsText: ' { } ' });
    const node = fresh(); const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'done' }));
    await execute({ calls: [completed], tools: [tool({ execute: perform })], node, signal: undefined, persistContent: inline, onChange: () => {} });
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ args: { n: 4 } }));
    expect(completed.function.arguments).toBe(' { } ');
    expect(node.parts).toEqual([{ type: 'tool_result', result: { toolCallId: completed.id, status: 'success', content: { type: 'text', text: 'done' } } }]);
  });

  it.each(['{"n":', '{"n":"bad"}', '{"n":4,"extra":true}'])('records invalid arguments without executing: %s', async argumentsText => {
    const node = fresh(); const perform = vi.fn<Tool['execute']>();
    await execute({ calls: [call({ id: 'call', name: 'f', argumentsText })], tools: [tool({ execute: perform })], node, signal: undefined, persistContent: inline, onChange: () => {} });
    expect(perform).not.toHaveBeenCalled();
    expect(node.parts[0]?.result).toMatchObject({ status: 'error', error: { code: 'invalid_arguments' } });
  });

  it('records an unavailable tool without executing anything else', async () => {
    const node = fresh(); const perform = vi.fn<Tool['execute']>();
    await execute({ calls: [call({ id: 'call', name: 'missing', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: undefined, persistContent: inline, onChange: () => {} });
    expect(perform).not.toHaveBeenCalled();
    expect(node.parts[0]?.result).toMatchObject({ status: 'error', error: { code: 'other', message: { type: 'text', text: 'Tool "missing" not found.' } } });
  });

  it('rejects ambiguous definitions, duplicate calls, and replay into an existing result node', async () => {
    const completed = call({ id: 'call', name: 'f', argumentsText: '{}' });
    const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'done' })); const implementation = tool({ execute: perform });
    await expect(execute({ calls: [completed], tools: [implementation, implementation], node: fresh(), signal: undefined, persistContent: inline, onChange: () => {} })).rejects.toThrow('definitions');
    await expect(execute({ calls: [completed, completed], tools: [implementation], node: fresh(), signal: undefined, persistContent: inline, onChange: () => {} })).rejects.toThrow('tool-call IDs');
    const node = fresh(); node.parts.push({ type: 'tool_result', result: { toolCallId: completed.id, status: 'executing' } });
    await expect(execute({ calls: [completed], tools: [implementation], node, signal: undefined, persistContent: inline, onChange: () => {} })).rejects.toThrow('new tool message');
    expect(perform).not.toHaveBeenCalled();
  });

  it('awaits async argument transformations before executing', async () => {
    const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'done' }));
    const implementation = tool({ execute: perform }); implementation.parametersSchema = z.object({ n: z.number().transform(async value => value + 1) });
    await execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{"n":2}' })], tools: [implementation], node: fresh(), signal: undefined, persistContent: inline, onChange: () => {} });
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ args: { n: 3 } }));
  });

  it('passes approval and awaits event observers without executing from the provider', async () => {
    const approval: ToolApprovalContext = { chatId: toChatId({ raw: 'chat' }), ensureApproval: async () => ({ status: 'approved' }) };
    const seen: string[] = [];
    const implementation = tool({ execute: async ({ approvalContext, onEvent }) => {
      expect(approvalContext).toBe(approval);
      await onEvent?.({ event: { type: 'started' } });
      expect(seen).toEqual(['started']);
      await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'line' } });
      return { status: 'success', content: 'done' };
    } });
    const completed = call({ id: 'call', name: 'f', argumentsText: '{}' });
    await executeChatToolCalls({ calls: [completed], tools: [implementation], node: fresh(), signal: undefined, approvalContext: approval, onChange: () => {}, persistContent: inline, onEvent: async ({ toolCallId, event }) => {
      await Promise.resolve(); expect(toolCallId).toBe(completed.id); seen.push(event.type);
    } });
    expect(seen).toEqual(['started', 'output']);
  });

  it('stores received success before binary persistence and retains it if storage fails', async () => {
    const node = fresh(); const fault = new Error('disk failed'); const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'already executed' }));
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: undefined, onChange: () => {}, persistContent: async () => {
      expect(node.parts[0]?.result).toMatchObject({ status: 'success', content: { type: 'text', text: 'already executed' } }); throw fault;
    } })).rejects.toBe(fault);
    expect(perform).toHaveBeenCalledTimes(1); expect(node.parts[0]?.result).toMatchObject({ status: 'success', content: { text: 'already executed' } });
  });

  it('does not enter the next tool until result persistence and notification have completed', async () => {
    const order: string[] = []; const node = fresh();
    const perform = vi.fn<Tool['execute']>(async () => {
      order.push('execute'); return { status: 'success', content: 'text' };
    });
    await execute({ calls: [call({ id: 'A', name: 'f', argumentsText: '{}' }), call({ id: 'B', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: undefined, onChange: () => {
      order.push('notify');
    }, persistContent: async () => {
      order.push('persist'); await Promise.resolve(); return { type: 'binary_object', id: toBinaryObjectId({ raw: 'binary' }) };
    } });
    expect(order).toEqual(['notify', 'execute', 'notify', 'persist', 'notify', 'notify', 'execute', 'notify', 'persist', 'notify']);
    expect(node.parts[1]?.result).toMatchObject({ content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'binary' }) } });
  });

  it('keeps an observed result on a late abort and never executes the next call', async () => {
    const controller = new AbortController(); const node = fresh(); const reason = new Error('user stopped');
    const perform = vi.fn<Tool['execute']>(async () => {
      controller.abort(reason); return { status: 'success', content: 'side effect done' };
    });
    await expect(execute({ calls: [call({ id: 'A', name: 'f', argumentsText: '{}' }), call({ id: 'B', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: controller.signal, onChange: () => {}, persistContent: inline })).rejects.toBe(reason);
    expect(perform).toHaveBeenCalledTimes(1); expect(node.parts).toHaveLength(1);
    expect(node.parts[0]?.result).toMatchObject({ status: 'success', content: { text: 'side effect done' } });
  });

  it('does not create executing results when stopped before execution starts', async () => {
    const controller = new AbortController(); controller.abort(); const node = fresh();
    const perform = vi.fn<Tool['execute']>();
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: controller.signal, onChange: () => {}, persistContent: inline })).rejects.toBe(controller.signal.reason);
    expect(node.parts).toEqual([]); expect(perform).not.toHaveBeenCalled();
  });

  it('records a result instead of leaving executing on a cooperative execution abort', async () => {
    const node = fresh(); const controller = new AbortController(); const reason = new Error('user stopped');
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async () => {
      controller.abort(reason); throw reason;
    } })], node, signal: controller.signal, onChange: () => {}, persistContent: inline })).rejects.toBe(reason);
    expect(node.parts[0]?.result).toMatchObject({ status: 'error', error: { code: 'other', message: { text: 'Tool execution was interrupted before completion.' } } });
  });

  it('propagates an observer failure rather than treating it as a recoverable tool error', async () => {
    const node = fresh(); const fault = new Error('observer');
    const completed = call({ id: 'call', name: 'f', argumentsText: '{}' });
    await expect(executeChatToolCalls({ calls: [completed], tools: [tool({ execute: async ({ onEvent }) => {
      await onEvent?.({ event: { type: 'started' } }); return { status: 'success', content: 'done' };
    } })], node, signal: undefined, approvalContext: undefined, onChange: () => {}, persistContent: inline, onEvent: () => {
      throw fault;
    } })).rejects.toBe(fault);
    expect(node.parts[0]?.result.status).toBe('error');
  });

  it('does not leave executing if the pre-execution notification fails', async () => {
    const node = fresh(); const fault = new Error('notification'); const perform = vi.fn<Tool['execute']>();
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: undefined, onChange: () => {
      throw fault;
    }, persistContent: inline })).rejects.toBe(fault);
    expect(perform).not.toHaveBeenCalled(); expect(node.parts[0]?.result.status).toBe('error');
  });

  it('only updates its own result node even when another branch has an identical call ID', async () => {
    const other = fresh(); other.parts.push({ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call' }), status: 'executing' } });
    const before = structuredClone(other); const node = fresh();
    await execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async () => ({ status: 'success', content: 'this branch' }) })], node, signal: undefined, onChange: () => {}, persistContent: inline });
    expect(other).toEqual(before); expect(node.parts[0]?.result).toMatchObject({ status: 'success' });
  });

  it('takes a call snapshot before asynchronous work', async () => {
    const second = call({ id: 'B', name: 'f', argumentsText: '{"n":7}' }); const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'done' }));
    await execute({ calls: [call({ id: 'A', name: 'f', argumentsText: '{}' }), second], tools: [tool({ execute: perform })], node: fresh(), signal: undefined, onChange: () => {
      second.function.arguments = '{"n":99}';
    }, persistContent: inline });
    expect(perform.mock.calls[1]?.[0].args).toEqual({ n: 7 });
  });

  it('ignores asynchronous tool events after the execution has settled', async () => {
    let late: Parameters<Tool['execute']>[0]['onEvent']; const observer = vi.fn();
    await executeChatToolCalls({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async ({ onEvent }) => {
      late = onEvent; return { status: 'success', content: 'done' };
    } })], node: fresh(), signal: undefined, approvalContext: undefined, onChange: () => {}, persistContent: inline, onEvent: observer });
    await late?.({ event: { type: 'output', stream: 'stdout', text: 'late' } });
    expect(observer).not.toHaveBeenCalled();
  });
  it('waits for accepted event callbacks even if the tool does not await them', async () => {
    const release = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    let settled = false; const node = fresh();
    const running = executeChatToolCalls({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async ({ onEvent }) => {
      void onEvent?.({ event: { type: 'started' } }); return { status: 'success', content: 'done' };
    } })], node, signal: undefined, approvalContext: undefined, onChange: () => {}, persistContent: inline, onEvent: async () => {
      entered.resolve(); await release.promise;
    } }).then(() => {
      settled = true;
    });
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve(); await running;
    expect(node.parts[0]?.result.status).toBe('success');
  });

  it('does not overwrite a result removed during binary persistence', async () => {
    const node = fresh(); const perform = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'done' }));
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: perform })], node, signal: undefined, onChange: () => {}, persistContent: async () => {
      node.parts = []; return { type: 'binary_object', id: toBinaryObjectId({ raw: 'unlinked' }) };
    } })).rejects.toThrow('changed during persistence');
    expect(node.parts).toEqual([]); expect(perform).toHaveBeenCalledTimes(1);
  });

  it('owns a rejected event promise even when the tool ignores the callback result', async () => {
    const fault = new Error('event observer'); const node = fresh();
    await expect(executeChatToolCalls({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async ({ onEvent }) => {
      void onEvent?.({ event: { type: 'started' } }); return { status: 'success', content: 'known outcome' };
    } })], node, signal: undefined, approvalContext: undefined, onChange: () => {}, persistContent: inline, onEvent: async () => {
      await Promise.resolve(); throw fault;
    } })).rejects.toBe(fault);
    expect(node.parts[0]?.result).toMatchObject({ status: 'success', content: { text: 'known outcome' } });
  });

  it('updates the owned reactive result after another part is inserted before it', async () => {
    const node = reactive(fresh());
    const statuses: string[] = [];
    const callId = toToolCallId({ raw: 'call' });
    const stop = watch(() => node.parts.find(part => part.result.toolCallId === callId)?.result.status,
      status => {
        if (status) statuses.push(status);
      }, { flush: 'sync' });
    const inserted: ToolMessageNode['parts'][number] = {
      type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'other' }), status: 'success', content: { type: 'text', text: 'untouched' } },
    };
    await execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async () => {
      node.parts.unshift(inserted);
      await Promise.resolve();
      return { status: 'success', content: 'done' };
    } })], node, signal: undefined, onChange: () => {}, persistContent: inline });
    stop();
    expect(statuses).toEqual(['executing', 'success']);
    expect(node.parts[0]).toEqual(inserted);
    expect(node.parts[1]?.result).toEqual({ toolCallId: callId, status: 'success', content: { type: 'text', text: 'done' } });
  });

  it('rejects a replacement result with the same call ID while execution is pending', async () => {
    const node = reactive(fresh());
    const replacement: ToolMessageNode['parts'][number] = {
      type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call' }), status: 'success', content: { type: 'text', text: 'replacement' } },
    };
    await expect(execute({ calls: [call({ id: 'call', name: 'f', argumentsText: '{}' })], tools: [tool({ execute: async () => {
      node.parts[0] = replacement;
      await Promise.resolve();
      return { status: 'success', content: 'owned outcome' };
    } })], node, signal: undefined, onChange: () => {}, persistContent: inline })).rejects.toThrow('removed or replaced');
    expect(node.parts).toEqual([replacement]);
  });

});
