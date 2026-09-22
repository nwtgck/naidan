import type { ToolCall, ToolMessageNode } from '@/01-models/types';
import type { Tool, ToolExecutionEvent, ToolExecutionOutcome, TextOrBinaryObject } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/01-models/tool-approval';
import type { ToolCallId } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';

/**
 * Executes only the completed calls of one assistant, writing into its owned
 * tool message. It never searches other branches by tool-call ID or regenerates
 * model-visible arguments from execution-time defaults and transformations.
 */
export async function executeChatToolCalls({ calls, tools, node, signal, approvalContext, onEvent, onChange, persistContent }: {
  calls: readonly ToolCall[],
  tools: readonly Tool[],
  node: ToolMessageNode,
  signal: AbortSignal | undefined,
  approvalContext: ToolApprovalContext | undefined,
  onEvent: ({ toolCallId, event }: { toolCallId: ToolCallId, event: ToolExecutionEvent }) => void | Promise<void>,
  onChange: () => void | Promise<void>,
  persistContent: ({ toolCallId, type, text }: { toolCallId: ToolCallId, type: 'result' | 'error', text: string }) => Promise<TextOrBinaryObject>,
}): Promise<void> {
  if (node.parts.length !== 0) throw new Error('Tool execution requires a new tool message.');
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate tool definitions.');
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Duplicate completed tool-call IDs.');
  const pendingCalls = calls.map(call => {
    const { id, type, function: fn, ...unhandled } = call;
    unhandled satisfies Record<PropertyKey, never>;
    const { name, arguments: argumentsText, ...unhandledFunction } = fn;
    unhandledFunction satisfies Record<PropertyKey, never>;
    return exactObject<ToolCall>()({ id, type, function: { name, arguments: argumentsText } });
  });

  const availableTools = new Map(tools.map(tool => [tool.name, {
    parametersSchema: tool.parametersSchema,
    execute: tool.execute.bind(tool),
  }]));

  for (const call of pendingCalls) {
    signal?.throwIfAborted();
    node.parts.push({ type: 'tool_result', result: { toolCallId: call.id, status: 'executing' } });
    // Capture the node's reactive view after insertion. Array positions can
    // change while execution or persistence is awaiting another operation.
    const part = node.parts.at(-1);
    if (!part) throw new Error('The owned tool result was removed or replaced.');
    // Notifications and persistence failures are not recoverable tool errors.
    try {
      await onChange();
      const tool = availableTools.get(call.function.name);
      let eventPhase: 'executing' | 'settled' = 'executing';
      let eventFailure: { error: unknown } | undefined;
      const eventJobs = new Set<Promise<void>>();
      let outcome: ToolExecutionOutcome;
      try {
        outcome = await execute();
      } catch (error) {
        outcome = {
          status: 'error', code: 'other',
          message: signal?.aborted ? 'Tool execution was interrupted before completion.' : error instanceof Error ? error.message : String(error),
        };
      } finally {
        eventPhase = 'settled';
      }

      if (!node.parts.includes(part) || part.result.toolCallId !== call.id) throw new Error('The owned tool result was removed or replaced.');
      let content: { type: 'result' | 'error', text: string };
      switch (outcome.status) {
      case 'success': {
        const { status, content: text, ...unhandled } = outcome;
        unhandled satisfies Record<PropertyKey, never>;
        part.result = { toolCallId: call.id, status, content: { type: 'text', text } };
        content = { type: 'result', text };
        break;
      }
      case 'error': {
        const { status, code, message, ...unhandled } = outcome;
        unhandled satisfies Record<PropertyKey, never>;
        part.result = { toolCallId: call.id, status, error: { code, message: { type: 'text', text: message } } };
        content = { type: 'error', text: message };
        break;
      }
      default: {
        const _ex: never = outcome;
        throw new Error(`Unhandled tool outcome: ${_ex}`);
      }
      }
      await Promise.all([...eventJobs]);
      if (eventFailure !== undefined) throw eventFailure.error;
      const recorded = part.result;
      await onChange();
      // Retain the inline result first. A failed binary write must not erase the
      // observed tool outcome or cause the side effect to be executed again.
      const stored = await persistContent({ toolCallId: call.id, ...content });
      if (!node.parts.includes(part) || part.result !== recorded) {
        throw new Error('The owned tool result changed during persistence.');
      }
      const persisted = (() => {
        switch (stored.type) {
        case 'text': {
          const { type, text, ...unhandled } = stored;
          unhandled satisfies Record<PropertyKey, never>;
          return exactObject<typeof stored>()({ type, text });
        }
        case 'binary_object': {
          const { type, id, ...unhandled } = stored;
          unhandled satisfies Record<PropertyKey, never>;
          return exactObject<typeof stored>()({ type, id });
        }
        default: {
          const _ex: never = stored;
          throw new Error(`Unhandled persisted tool content: ${_ex}`);
        }
        }
      })();
      switch (outcome.status) {
      case 'success': part.result = { toolCallId: call.id, status: 'success', content: persisted }; break;
      case 'error': part.result = { toolCallId: call.id, status: 'error', error: { code: outcome.code, message: persisted } }; break;
      default: {
        const _ex: never = outcome;
        throw new Error(`Unhandled tool outcome: ${_ex}`);
      }
      }
      await onChange();
      // Cancellation after execute() resolved cannot erase its known success.
      // It does prevent any subsequent completed call from being executed.
      signal?.throwIfAborted();

      async function execute(): Promise<ToolExecutionOutcome> {
        if (!tool) return { status: 'error', code: 'other', message: `Tool "${call.function.name}" not found.` };
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch (error) {
          return { status: 'error', code: 'invalid_arguments', message: `Failed to parse tool arguments: ${error instanceof Error ? error.message : String(error)}` };
        }
        const validation = await tool.parametersSchema.strict().safeParseAsync(parsed);
        signal?.throwIfAborted();
        if (!validation.success) return { status: 'error', code: 'invalid_arguments', message: `Invalid arguments: ${validation.error.message}` };
        signal?.throwIfAborted();
        return await tool.execute({
          args: validation.data,
          signal,
          approvalContext,
          onEvent: ({ event }) => {
            switch (eventPhase) {
            case 'settled': return;
            case 'executing': break;
            default: {
              const _ex: never = eventPhase;
              throw new Error(`Unhandled tool event phase: ${_ex}`);
            }
            }
            const pending = (async () => {
              await onEvent({ toolCallId: call.id, event });
            })();
            // Own all accepted notifications even when a tool forgets to await
            // its callback. The original failure still reaches an awaiting tool.
            const tracked = pending.then(
              () => {},
              error => {
                eventFailure = { error };
              },
            );
            eventJobs.add(tracked);
            void tracked.then(() => {
              eventJobs.delete(tracked);
            });
            return pending;
          },
        });
      }
    } catch (error) {
      const unfinished = node.parts.includes(part) ? part : undefined;
      if (unfinished?.result.toolCallId === call.id) {
        switch (unfinished.result.status) {
        case 'executing':
          unfinished.result = {
            toolCallId: call.id, status: 'error',
            error: { code: 'other', message: { type: 'text', text: 'Tool execution stopped before producing a result.' } },
          };
          break;
        case 'success':
        case 'error': break;
        default: {
          const _ex: never = unfinished.result;
          throw new Error(`Unhandled tool result: ${_ex}`);
        }
        }
      }
      throw error;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
