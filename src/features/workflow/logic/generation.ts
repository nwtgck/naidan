import { resolveLmParameterLayers } from '@/logic/chat-settings-resolver';
import type { LmProvider, ChatGenerationResult } from '@/01-models/lm';
import type { ChatMessage } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import type { WorkflowGenerationInput, WorkflowOutputs } from './runtime';
import { retainValue, releaseValues, readText, textChunks, spoolText, WORKFLOW_INPUT_LIMIT, type RuntimeValue } from './values';

export type WorkflowGenerationProgress =
  | { type: 'input', text: string }
  | { type: 'chunk', partId: string, index: number, channel: 'text' | 'reasoning', text: string };

/** Uses the provider's operation owner; it deliberately does not duplicate the chat tool/approval loop. */
export async function generateWorkflowText({ input, provider, onProgress }: { input: WorkflowGenerationInput, provider: LmProvider, onProgress?: ({ event }: { event: WorkflowGenerationProgress }) => void }): Promise<WorkflowOutputs> {
  const { step, target, conversation, signal, store, ...unhandled } = input;
  unhandled satisfies Record<PropertyKey, never>;
  if (step.toolConfigs.some(config => config.status === 'enabled')) {
    throw new Error('Workflow tools are not integrated yet.');
  }
  if (conversation.length > 256) {
    throw new Error('Conversation exceeds 256 messages.');
  }
  const finalRole = conversation.at(-1)?.role;
  switch (finalRole) {
  case 'user': break;
  case 'system': case 'assistant': case undefined: throw new Error('A new response requires the conversation to end with a user message.');
  default: {
    const exhaustive: never = finalRole;
    throw new Error(`Unknown final role: ${exhaustive}`);
  }
  }
  if (!target.modelId.trim()) {
    throw new Error('Select a model before running.');
  }
  const history: ChatMessage[] = [];
  let inputBytes = 0;
  for (const message of conversation) {
    const parts: { type: 'text', text: string, completeness: 'complete' }[] = [];
    for (const value of message.parts) {
      const text = await readText({ value, maxBytes: WORKFLOW_INPUT_LIMIT, signal });
      inputBytes += new TextEncoder().encode(text).byteLength;
      if (inputBytes > WORKFLOW_INPUT_LIMIT) {
        throw new Error('Conversation exceeds the materialization limit.');
      }
      parts.push({ type: 'text', text, completeness: 'complete' });
    }
    history.push({ id: generateId<MessageId>(), role: message.role, parts });
  }
  const system = step.systemPrompt;
  if (system) {
    switch (system.behavior) {
    case 'override':
      for (let index = history.length - 1; index >= 0; index--) {
        const role = history[index]!.role;
        switch (role) {
        case 'system': history.splice(index, 1);
          break;
        case 'user': case 'assistant': case 'tool': break;
        default: {
          const exhaustive: never = role;
          throw new Error(`Unknown role: ${exhaustive}`);
        }
        }
      }
      break;
    case 'append': break;
    default: {
      const exhaustive: never = system;
      throw new Error(`Unknown prompt behavior: ${exhaustive}`);
    }
    }
    if (system.content) {
      inputBytes += new TextEncoder().encode(system.content).byteLength;
      if (inputBytes > WORKFLOW_INPUT_LIMIT) {
        throw new Error('Conversation exceeds the materialization limit.');
      }
      history.unshift({ id: generateId<MessageId>(), role: 'system', parts: [{ type: 'text', text: system.content, completeness: 'complete' }] });
    }
  }
  if (onProgress) {
    // Preview the actual resolved request, after system-prompt replacement. The
    // UI sees a bounded excerpt; the provider still receives the complete input.
    let preview = '';
    for (const message of history) {
      if (preview.length >= 4096) {
        break;
      }
      preview += `${message.role}:\n`;
      for (const part of message.parts) {
        switch (part.type) {
        case 'text': preview += part.text.slice(0, Math.max(0, 4096 - preview.length));
          break;
        case 'reasoning': case 'attachment': case 'tool_call': case 'tool_result': break;
        default: {
          const exhaustive: never = part;
          throw new Error(String(exhaustive));
        }
        }
      }
      preview += '\n\n';
    }
    onProgress({ event: { type: 'input', text: preview.slice(0, 4096) } });
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const parts: { type: 'text' | 'reasoning', index: number, value: RuntimeValue }[] = [];
  const pending: Promise<void>[] = [];
  const seenIds = new Set<string>(), seenIndices = new Set<number>();
  let failure: unknown;
  let result: ChatGenerationResult | undefined;
  const owned: RuntimeValue[] = [];
  const run = async ({ chat, signal: operationSignal }: { chat: LmProvider['chat'], signal: AbortSignal }): Promise<void> => {
    for await (const item of chat({ messages: history, model: target.modelId, parameters: resolveLmParameterLayers({ layers: [target.lmParameters, step.lmParameters] }), tools: undefined, readBinaryObject: undefined, debug: 'off', signal: operationSignal })) {
      controller.signal.throwIfAborted();
      switch (item.type) {
      case 'text': case 'reasoning': {
        if (!Number.isSafeInteger(item.index) || item.index < 0 || seenIds.size >= 64 || seenIds.has(item.partId) || seenIndices.has(item.index)) {
          throw new Error('Invalid or excessive generation parts.');
        }
        seenIds.add(item.partId);
        seenIndices.add(item.index);
        // Parts can be interleaved. Consume concurrently, preserving logical indices,
        // while each sink awaits its writes. The provider still owns its receive queue.
        // Completeness may reject before its text stream ends. Observe it now,
        // and propagate the failure without leaving an unhandled rejection.
        const completion = item.completeness.then(value => ({ type: 'ok' as const, value }), error => {
          failure ??= error;
          controller.abort(error);
          return { type: 'error' as const, error };
        });
        const textItem = item;
        const task = (async () => {
          async function* observedChunks(): AsyncGenerator<string> {
            for await (const chunk of textItem.chunks) {
              onProgress?.({ event: { type: 'chunk', partId: textItem.partId, index: textItem.index, channel: textItem.type, text: chunk.slice(-4096) } });
              yield chunk;
            }
          }
          const value = await spoolText({ store, signal: operationSignal, chunks: observedChunks() });
          owned.push(value);
          const completionResult = await completion;
          switch (completionResult.type) {
          case 'error': throw completionResult.error;
          case 'ok':
            switch (completionResult.value) {
            case 'complete': break;
            case 'partial': throw new Error('The generated message is incomplete.');
            default: {
              const exhaustive: never = completionResult.value;
              throw new Error(`Unknown completion state: ${exhaustive}`);
            }
            }
            break;
          default: {
            const exhaustive: never = completionResult;
            throw new Error(`Unknown result: ${exhaustive}`);
          }
          }
          parts.push({ type: item.type, index: item.index, value });
        })().catch(error => {
          failure ??= error;
          controller.abort(error);
        });
        pending.push(task);
        break;
      }
      case 'tool_call_draft': case 'tool_call': throw new Error('The model requested a tool, but this Workflow step has no tool execution authority.');
      case 'result': if (result) {
        throw new Error('Duplicate generation result.');
      }
        result = item.result;
        break;
      default: {
        const exhaustive: never = item;
        throw new Error(`Unknown generation item: ${exhaustive}`);
      }
      }
    }
    await Promise.all(pending);
    if (failure) {
      throw failure;
    }
    operationSignal.throwIfAborted();
    if (!result) {
      throw new Error('The provider ended without a completion result.');
    }
    switch (result.type) {
    case 'finished':
      switch (result.next) {
      case 'user': break;
      case 'tool_results': throw new Error('The provider requires unsupported tool results.');
      default: {
        const exhaustive: never = result.next;
        throw new Error(`Unknown next role: ${exhaustive}`);
      }
      }
      break;
    case 'interrupted': throw new Error(`Generation interrupted: ${result.reason}`);
    case 'error': throw result.error;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unknown generation result: ${exhaustive}`);
    }
    }
  };
  try {
    if (provider.runChatOperation) {
      await provider.runChatOperation({ signal: controller.signal, operation: run });
    } else {
      await run({ chat: provider.chat.bind(provider), signal: controller.signal });
    }
    const sorted = parts.sort((a, b) => a.index - b.index);
    async function* combined({ type }: { type: 'text' | 'reasoning' }): AsyncGenerator<string> {
      for (const part of sorted) {
        if (part.type === type) {
          yield* textChunks({ value: part.value, signal });
        }
      }
    }
    const text = await spoolText({ store, signal, chunks: combined({ type: 'text' }) });
    owned.push(text);
    const reasoning = await spoolText({ store, signal, chunks: combined({ type: 'reasoning' }) });
    owned.push(reasoning);
    // Conversation output records the effective context actually sent, rather
    // than restoring system messages removed by an override.
    const messages = conversation
      .filter(message => system?.behavior !== 'override' || message.role !== 'system')
      .map(message => ({ ...message, parts: message.parts.map(value => retainValue({ value })) }));
    if (system?.content) {
      messages.unshift({ role: 'system', parts: [{ type: 'json', value: system.content }] });
    }
    messages.push({ role: 'assistant', parts: [retainValue({ value: text })] });
    // Only safe result data is exposed; no provider endpoint or authentication headers.
    const metrics: RuntimeValue = { type: 'json', value: { inputBytes, outputBytes: text.output.byteLength } };
    return { text: retainValue({ value: text }), reasoning: retainValue({ value: reasoning }), conversation: { type: 'conversation', messages }, metrics };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await Promise.all(pending);
    await releaseValues({ values: owned });
  }
}

export const TEST_ONLY = {
};
