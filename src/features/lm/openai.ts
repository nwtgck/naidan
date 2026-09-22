/**
 * OpenAI Service Provider
 *
 * This file handles communication with OpenAI compatible APIs.
 *
 * CRITICAL: All API responses MUST be validated using Zod schemas.
 * External APIs are unreliable and may change their response structure without notice.
 * Validation ensures that type errors do not leak into the application logic
 * and that we handle unexpected API behavior gracefully.
 */
import { z } from 'zod';
import { toToolCallId, type BinaryObjectId } from '@/01-models/ids';
import type { LmParameters, ChatMessage } from '@/01-models/types';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { getDefaultLmFetch, type LmFetch } from '@/features/lm/fetch';
import type { LmProvider, ChatGenerationItem, ChatGenerationResult, JsonValue } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { buildApiChatMessages, snapshotChatRequest, type ApiChatMessage } from './chat-request';
import { readSseData, readApiErrorDetails } from './response-stream';

const { addErrorEvent } = useGlobalEvents();

const OpenAIChatChunkSchema = z.object({
  choices: z.array(z.object({
    index: z.number().int().nonnegative().optional(),
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }).optional(),
  })),
});

const OpenAIModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
  })),
});

interface OpenAICompletionRequest {
  model: string,
  messages: ApiChatMessage[],
  stream: boolean,
  temperature?: number,
  top_p?: number,
  max_completion_tokens?: number,
  presence_penalty?: number,
  frequency_penalty?: number,
  stop?: string[],
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high',
  tools?: {
    type: 'function',
    function: {
      name: string,
      description: string,
      parameters: { [key: string]: JsonValue },
    },
  }[],
}

export class OpenAIProvider implements LmProvider {
  private config: {
    endpoint: string,
    headers?: [string, string][],
    fetcher: LmFetch,
  };

  constructor({ endpoint, headers, fetcher }: { endpoint: string, headers?: [string, string][], fetcher?: LmFetch }) {
    this.config = { endpoint, headers, fetcher: fetcher ?? getDefaultLmFetch() };
  }

  chat({ messages, model, parameters, tools, readBinaryObject, signal }: {
    messages: readonly ChatMessage[],
    model: string,
    parameters: LmParameters | undefined,
    tools: Parameters<LmProvider['chat']>[0]['tools'],
    readBinaryObject: (({ binaryObjectId, signal }: { binaryObjectId: BinaryObjectId, signal: AbortSignal | undefined }) => Promise<Blob>) | undefined,
    signal: AbortSignal | undefined,
  }): AsyncIterable<ChatGenerationItem> {
    const snapshot = snapshotChatRequest({ messages, parameters, tools });
    const { endpoint, headers, fetcher } = this.config;
    const requestHeaders = headers?.map(([name, value]): [string, string] => [name, value]);
    return createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
      const body: OpenAICompletionRequest = {
        model, messages: await buildApiChatMessages({ messages: snapshot.messages, readBinaryObject, signal }), stream: true,
      };
      if (snapshot.parameters) {
        const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...unhandled } = snapshot.parameters;
        unhandled satisfies Record<PropertyKey, never>;
        body.temperature = temperature; body.top_p = topP; body.max_completion_tokens = maxCompletionTokens;
        body.presence_penalty = presencePenalty; body.frequency_penalty = frequencyPenalty; body.stop = stop;
        body.reasoning_effort = reasoning.effort;
      }
      if (snapshot.tools?.length) body.tools = snapshot.tools.map(tool => ({ type: 'function', function: tool }));
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'POST', headers: [['Content-Type', 'application/json'], ...(requestHeaders ?? [])],
          body: JSON.stringify(body), signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const message = `Network error or CORS issue: ${error instanceof Error ? error.message : String(error)}. Please check if the server is running and your endpoint URL is correct.`;
        addErrorEvent({ source: 'OpenAIProvider', message, details: { error, url, method: 'POST' } });
        throw new Error(message);
      }
      if (!response.ok) {
        const message = `OpenAI API Error (${response.status}): ${await readApiErrorDetails({ response })}`;
        addErrorEvent({ source: 'OpenAIProvider', message, details: { status: response.status, url } });
        throw new Error(message);
      }
      const drafts: { key: number, id: string | undefined, name: string, arguments: string }[] = [];
      const currentByIndex = new Map<number, typeof drafts[number]>();
      async function completeCalls(): Promise<void> {
        const ids = new Set<string>();
        for (const call of drafts) {
          if (!call.id || !call.name || ids.has(call.id)) throw new Error('Incomplete or duplicate tool call in a completed response.');
          ids.add(call.id);
        }
        for (const call of drafts) {
          // A terminal API event, not successful JSON parsing, completes this call.
          await writer.call({ key: call.key, toolCall: { id: toToolCallId({ raw: call.id! }), type: 'function', function: { name: call.name, arguments: call.arguments } } });
        }
      }
      try {
        for await (const data of readSseData({ response, signal })) {
          if (data === '[DONE]') {
            await completeCalls();
            return { type: 'finished', next: drafts.length ? 'tool_results' : 'user' };
          }
          const chunk = OpenAIChatChunkSchema.parse(JSON.parse(data));
          if (chunk.choices.length > 1) throw new Error('Multiple generated choices are not supported in one assistant message.');
          const choice = chunk.choices[0];
          if (!choice) continue; // Usage-only event.
          if (choice.index !== undefined && choice.index !== 0) throw new Error('Unexpected choice index.');
          const delta = choice.delta;
          if (delta) {
            if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning !== delta.reasoning_content) {
              throw new Error('Conflicting reasoning fields in the same response chunk.');
            }
            const reasoning = delta.reasoning ?? delta.reasoning_content;
            // Empty deltas are API keep-alives/placeholders, not declared empty parts.
            if (reasoning) await writer.text({ type: 'reasoning', text: reasoning });
            if (delta.content) await writer.text({ type: 'text', text: delta.content });
            for (const piece of delta.tool_calls ?? []) {
              let draft = currentByIndex.get(piece.index);
              if (!draft || (piece.id && draft.id && draft.id !== piece.id)) {
                draft = { key: drafts.length, id: piece.id, name: '', arguments: '' };
                drafts.push(draft); currentByIndex.set(piece.index, draft);
                writer.reserveCall({ key: draft.key });
              }
              if (piece.id) draft.id = piece.id;
              // Delta text is never deduplicated because two equal fragments can be intentional.
              draft.name += piece.function?.name ?? '';
              draft.arguments += piece.function?.arguments ?? '';
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            switch (choice.finish_reason) {
            case 'stop':
            case 'tool_calls':
              await completeCalls();
              return { type: 'finished', next: drafts.length ? 'tool_results' : 'user' };
            case 'length': return { type: 'interrupted', reason: 'limit' };
            default: return { type: 'interrupted', reason: 'unknown' };
            }
          }
        }
        // A socket closing by itself is not a model-level completion event.
        return { type: 'interrupted', reason: 'unknown' } satisfies ChatGenerationResult;
      } catch (error) {
        if (!signal.aborted) addErrorEvent({ source: 'OpenAIProvider', message: 'Failed to read or validate the generation stream', details: { error: error instanceof Error ? error : String(error) } });
        throw error;
      }
    } });
  }

  async listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    const { endpoint, headers, fetcher } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/models`;
    let response: Response;
    try {
      response = await fetcher(url, { signal, headers });
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (!isAbort) {
        const message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}. Please check if the server is running and your endpoint URL is correct.`;
        addErrorEvent({
          source: 'OpenAIProvider:listModels',
          message,
          details: { error: e, url },
        });
        throw new Error(message);
      }
      throw e;
    }

    if (!response.ok) {
      const details = await readApiErrorDetails({ response });
      const errorMsg = `Failed to fetch models (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OpenAIProvider:listModels',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url },
      });
      throw new Error(errorMsg);
    }
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OpenAIModelsSchema.parse(rawJson);
    return validated.data.map((m) => m.id);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
