import { resolveLmParameterLayers } from '@/logic/chat-settings-resolver';
import type { LmProvider, ChatGenerationResult } from '@/01-models/lm';
import { idToRaw } from '@/01-models/ids';
import type { WorkflowGenerationInput, WorkflowOutputs } from './runtime';
import { materializeWorkflowConversation, workflowToolCall } from './conversation';
import type { WorkflowModelTools } from './model-tools';
import { resolveWorkflowToolPolicy } from './tool-policy';
import { retainRuntimeMessage, retainValue, releaseValues, textChunks, spoolText, WORKFLOW_INPUT_LIMIT, type RuntimeValue, type RuntimeMessage, type RuntimeMessagePart, type RuntimeToolCall } from './values';

export type WorkflowGenerationProgress =
  | { type: 'input', text: string }
  | { type: 'chunk', partId: string, index: number, channel: 'text' | 'reasoning', text: string }
  | { type: 'tool', callId: string, name: string, phase: 'draft' | 'running' | 'completed', text: string };

/** Hold one provider operation across bounded generation/tool rounds. Historical
 * calls are data; only completed calls from this operation may be executed. */
export async function generateWorkflowText({ input, provider, tools, onProgress }: {
  input: WorkflowGenerationInput, provider: LmProvider, tools?: WorkflowModelTools,
  onProgress?: ({ event }: { event: WorkflowGenerationProgress }) => void,
}): Promise<WorkflowOutputs> {
  const { step, target, conversation, signal, store, targetSources: _targetSources, ...unhandled } = input;
  unhandled satisfies Record<PropertyKey, never>;
  const policy = resolveWorkflowToolPolicy({ policy: step.toolExecution });
  if (step.toolConfigs.some(config => config.status === 'enabled') && !tools) {
    throw new Error('Workflow tools require an execution authority.');
  }
  const finalRole = conversation.at(-1)?.role;
  switch (finalRole) {
  case 'user': case 'tool': break;
  case 'system': case 'assistant': case undefined: throw new Error('A new response requires the conversation to end with a user message or completed tool results.');
  default: {
    const exhaustive: never = finalRole;
    throw new Error(`Unknown final role: ${exhaustive}`);
  }
  }
  if (!target.modelId.trim()) {
    throw new Error('Select a model before running.');
  }
  // Borrow input leases for this call; the runtime keeps them alive until this
  // function settles. Newly generated leases are all tracked in owned.
  const history: RuntimeMessage[] = conversation.filter(message => step.systemPrompt?.behavior !== 'override' || message.role !== 'system');
  if (step.systemPrompt?.content) {
    history.unshift({ role: 'system', parts: [{ type: 'json', value: step.systemPrompt.content }] });
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const owned: RuntimeValue[] = [];
  const pending: Promise<void>[] = [];
  const seenToolIds = new Set(history.flatMap(message => message.parts.flatMap(part => {
    switch (part.type) {
    case 'tool_call': return [idToRaw({ id: part.id })];
    case 'json': case 'model': case 'range': case 'text': case 'binary': case 'sequence': case 'array': case 'object': case 'conversation': case 'tool_result': case 'reasoning': return [];
    default: {
      const exhaustive: never = part;
      throw new Error(String(exhaustive));
    }
    }
  })));
  const allReasoning: RuntimeValue[] = [];
  let finalText: Extract<RuntimeValue, { type: 'text' }> | undefined;
  let inputBytes = 0, rounds = 0, callCount = 0;
  async function combine({ values, operationSignal }: { values: RuntimeValue[], operationSignal: AbortSignal }): Promise<Extract<RuntimeValue, { type: 'text' }>> {
    async function* chunks() {
      for (const value of values) {
        yield* textChunks({ value, signal: operationSignal });
      }
    }
    const value = await spoolText({ store, signal: operationSignal, chunks: chunks() });
    owned.push(value);
    return value;
  }
  const run = async ({ chat, signal: operationSignal }: { chat: LmProvider['chat'], signal: AbortSignal }): Promise<void> => {
    for (rounds = 1; rounds <= policy.maxRounds; rounds++) {
      controller.signal.throwIfAborted();
      operationSignal.throwIfAborted();
      const materialized = await materializeWorkflowConversation({ messages: history, signal: operationSignal });
      inputBytes += materialized.byteLength;
      if (onProgress) {
        let preview = '';
        for (const message of materialized.messages) {
          if (preview.length >= 4096) {
            break;
          }
          preview += `${message.role}:\n`;
          for (const part of message.parts) {
            switch (part.type) {
            case 'text': case 'reasoning': preview += part.text.slice(0, Math.max(0, 4096 - preview.length));
              break;
            case 'tool_call': preview += `${part.toolCall.function.name} ${part.toolCall.function.arguments}`.slice(0, Math.max(0, 4096 - preview.length));
              break;
            case 'tool_result': preview += JSON.stringify(part.result).slice(0, Math.max(0, 4096 - preview.length));
              break;
            case 'attachment': break;
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
      const parts: ({ type: 'text' | 'reasoning', index: number, value: RuntimeValue } | { type: 'tool_call', index: number, part: RuntimeToolCall })[] = [];
      const seenIds = new Set<string>(), seenIndices = new Set<number>();
      const drafts = new Map<string, { index: number, name: string, arguments: string }>();
      let result: ChatGenerationResult | undefined;
      let failure: unknown;
      const roundPending: Promise<void>[] = [];
      try {
        for await (const item of chat({
          messages: materialized.messages,
          model: target.modelId,
          parameters: resolveLmParameterLayers({ layers: [target.lmParameters, step.lmParameters] }),
          tools: tools?.definitions.length ? tools.definitions : undefined,
          readBinaryObject: undefined,
          debug: 'off',
          signal: operationSignal,
        })) {
          controller.signal.throwIfAborted();
          operationSignal.throwIfAborted();
          if (result) {
            throw new Error('The provider published an item after its completion result.');
          }
          switch (item.type) {
          case 'text': case 'reasoning': case 'tool_call': {
            if (!item.partId || item.partId.length > 200 || !Number.isSafeInteger(item.index) || item.index < 0 || seenIds.size >= 64 || seenIds.has(item.partId) || seenIndices.has(item.index)) {
              throw new Error('Invalid or excessive generation parts.');
            }
            const draft = drafts.get(item.partId);
            if ([...drafts].some(([id, other]) => id !== item.partId && other.index === item.index)) {
              throw new Error('Two provider parts claimed the same draft position.');
            }
            if (draft && (item.type !== 'tool_call' || draft.index !== item.index)) {
              throw new Error('A completed tool call changed its draft identity.');
            }
            seenIds.add(item.partId);
            seenIndices.add(item.index);
            switch (item.type) {
            case 'tool_call': {
              if (!tools || !tools.definitions.some(tool => tool.name === item.toolCall.function.name)) {
                throw new Error('The model requested a tool, but this Workflow step has no tool execution authority.');
              }
              const part: RuntimeToolCall = { type: 'tool_call', id: item.toolCall.id, name: item.toolCall.function.name, arguments: item.toolCall.function.arguments };
              workflowToolCall({ part });
              const id = idToRaw({ id: part.id });
              if (seenToolIds.has(id)) {
                throw new Error('Duplicate generated tool call identity.');
              }
              seenToolIds.add(id);
              parts.push({ type: 'tool_call', index: item.index, part });
              continue;
            }
            case 'text': case 'reasoning': break;
            default: {
              const exhaustive: never = item;
              throw new Error(String(exhaustive));
            }
            }
            const textItem = item;
            // Observe both promises immediately; drain all streams before tools
            // or cleanup, including when the provider itself throws.
            const completion = textItem.completeness.then(value => ({ type: 'ok' as const, value }), error => {
              failure ??= error;
              controller.abort(error);
              return { type: 'error' as const, error };
            });
            const round = rounds;
            const task = (async () => {
              async function* chunks() {
                for await (const chunk of textItem.chunks) {
                  onProgress?.({ event: { type: 'chunk', partId: `${round}:${textItem.partId}`, index: round * 64 + textItem.index, channel: textItem.type, text: chunk.slice(-4096) } });
                  yield chunk;
                }
              }
              const value = await spoolText({ store, signal: operationSignal, chunks: chunks() });
              owned.push(value);
              const completed = await completion;
              switch (completed.type) {
              case 'error': throw completed.error;
              case 'ok':
                switch (completed.value) {
                case 'complete': break;
                case 'partial': throw new Error('The generated message is incomplete.');
                default: {
                  const exhaustive: never = completed.value;
                  throw new Error(String(exhaustive));
                }
                }
                break;
              default: {
                const exhaustive: never = completed;
                throw new Error(String(exhaustive));
              }
              }
              parts.push({ type: textItem.type, index: textItem.index, value });
            })().catch(error => {
              failure ??= error;
              controller.abort(error);
            });
            roundPending.push(task);
            pending.push(task);
            break;
          }
          case 'tool_call_draft': {
            if (!tools || !item.partId || item.partId.length > 200 || !Number.isSafeInteger(item.index) || item.index < 0 || seenIds.has(item.partId) || seenIndices.has(item.index)) {
              throw new Error('Invalid tool call draft or missing Workflow tool authority.');
            }
            const prior = drafts.get(item.partId) ?? { index: item.index, name: '', arguments: '' };
            if (drafts.size >= 64 && !drafts.has(item.partId) || prior.index !== item.index || [...drafts].some(([id, draft]) => id !== item.partId && draft.index === item.index)) {
              throw new Error('Invalid or excessive tool drafts.');
            }
            const update = item.arguments;
            if (update && (!Number.isSafeInteger(update.offset) || update.offset < 0 || update.offset > prior.arguments.length)) {
              throw new Error('Invalid tool draft offset.');
            }
            const current = { index: item.index, name: item.name ?? prior.name, arguments: update ? prior.arguments.slice(0, update.offset) + update.text : prior.arguments };
            if (current.name.length > 200 || new TextEncoder().encode(current.arguments).byteLength > 128 * 1024) {
              throw new Error('Tool draft exceeds its limit.');
            }
            drafts.set(item.partId, current);
            onProgress?.({ event: { type: 'tool', callId: item.partId, name: current.name, phase: 'draft', text: current.arguments.slice(-4096) } });
            break;
          }
          case 'result': result = item.result;
            break;
          default: {
            const exhaustive: never = item;
            throw new Error(`Unknown generation item: ${exhaustive}`);
          }
          }
        }
      } catch (reason) {
        controller.abort(reason);
        throw reason;
      } finally {
        await Promise.all(roundPending);
      }
      if (failure) {
        throw failure;
      }
      controller.signal.throwIfAborted();
      operationSignal.throwIfAborted();
      if (!result) {
        throw new Error('The provider ended without a completion result.');
      }
      switch (result.type) {
      case 'finished': break;
      case 'interrupted': throw new Error(`Generation interrupted: ${result.reason}`);
      case 'error': throw result.error;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unknown generation result: ${exhaustive}`);
      }
      }
      const sorted = parts.sort((a, b) => a.index - b.index);
      const calls = sorted.filter(part => part.type === 'tool_call');
      allReasoning.push(...sorted.flatMap(part => {
        switch (part.type) {
        case 'reasoning': return [part.value];
        case 'text': case 'tool_call': return [];
        default: {
          const exhaustive: never = part;
          throw new Error(String(exhaustive));
        }
        }
      }));
      switch (result.next) {
      case 'user': {
        if (calls.length || [...drafts.keys()].some(id => !seenIds.has(id))) {
          throw new Error('The provider completed with unanswered or incomplete tool calls.');
        }
        finalText = await combine({
          values: sorted.flatMap(part => {
            switch (part.type) {
            case 'text': return [part.value];
            case 'reasoning': case 'tool_call': return [];
            default: {
              const exhaustive: never = part;
              throw new Error(String(exhaustive));
            }
            }
          }),
          operationSignal,
        });
        history.push({
          role: 'assistant',
          parts: sorted.map<RuntimeMessagePart>(part => {
            switch (part.type) {
            case 'reasoning': return { type: 'reasoning', content: part.value };
            case 'text': return part.value;
            case 'tool_call': throw new Error('Unexpected tool call in a completed answer.');
            default: {
              const exhaustive: never = part;
              throw new Error(String(exhaustive));
            }
            }
          }),
        });
        return;
      }
      case 'tool_results': break;
      default: {
        const exhaustive: never = result.next;
        throw new Error(String(exhaustive));
      }
      }
      if (!tools || !calls.length || [...drafts.keys()].some(id => !seenIds.has(id))) {
        throw new Error('The provider requires missing or unauthorized tool results.');
      }
      if (rounds >= policy.maxRounds || callCount + calls.length > policy.maxCalls) {
        throw new Error('Workflow model tool execution limit exceeded.');
      }
      const assistantParts: RuntimeMessagePart[] = sorted.flatMap<RuntimeMessagePart>(part => {
        switch (part.type) {
        case 'text': return [part.value];
        case 'reasoning': return [{ type: 'reasoning', content: part.value }];
        case 'tool_call': return [part.part];
        default: {
          const exhaustive: never = part;
          throw new Error(String(exhaustive));
        }
        }
      });
      const assistant: RuntimeMessage = { role: 'assistant', parts: assistantParts };
      // Validate all known conversation bytes and message capacity before any
      // external side effect. Real tool-result bytes are checked on arrival.
      await materializeWorkflowConversation({
        messages: [...history, assistant, ...calls.map<RuntimeMessage>(({ part }) => ({
          role: 'tool',
          parts: [{ type: 'tool_result', id: part.id, status: 'success', code: undefined, content: { type: 'json', value: '' } }],
        }))],
        signal: operationSignal,
      });
      history.push(assistant);
      for (const call of calls) {
        operationSignal.throwIfAborted();
        controller.signal.throwIfAborted();
        callCount++;
        const part = call.part;
        onProgress?.({ event: { type: 'tool', callId: idToRaw({ id: part.id }), name: part.name, phase: 'running', text: part.arguments.slice(0, 4096) } });
        const outcome = await tools.execute({ call: workflowToolCall({ part }), signal: operationSignal });
        operationSignal.throwIfAborted();
        controller.signal.throwIfAborted();
        const { text, code } = (() => {
          switch (outcome.status) {
          case 'success': return { text: outcome.content, code: undefined };
          case 'error': return { text: outcome.message, code: outcome.code };
          default: {
            const exhaustive: never = outcome;
            throw new Error(String(exhaustive));
          }
          }
        })();
        if (new TextEncoder().encode(text).byteLength > WORKFLOW_INPUT_LIMIT) {
          throw new Error('Tool result exceeds the model context input limit.');
        }
        const content = await spoolText({
          store,
          signal: operationSignal,
          chunks: (async function* () {
            yield text;
          })(),
        });
        owned.push(content);
        history.push({ role: 'tool', parts: [{ type: 'tool_result', id: part.id, status: outcome.status, code, content }] });
        onProgress?.({ event: { type: 'tool', callId: idToRaw({ id: part.id }), name: part.name, phase: 'completed', text: text.slice(-4096) } });
      }
    }
    throw new Error('Workflow model generation limit exceeded.');
  };
  try {
    if (provider.runChatOperation) {
      await provider.runChatOperation({ signal: controller.signal, operation: run });
    } else {
      await run({ chat: provider.chat.bind(provider), signal: controller.signal });
    }
    signal.throwIfAborted();
    if (!finalText) {
      throw new Error('The provider operation ended without a final response.');
    }
    const reasoning = await combine({ values: allReasoning, operationSignal: controller.signal });
    return {
      text: retainValue({ value: finalText }),
      reasoning: retainValue({ value: reasoning }),
      conversation: { type: 'conversation', messages: history.map(message => retainRuntimeMessage({ message })) },
      metrics: { type: 'json', value: { inputBytes, outputBytes: finalText.output.byteLength, rounds, toolCalls: callCount } },
    };
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
