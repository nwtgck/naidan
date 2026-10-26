import { resolveLlamaCppServerTimings } from './llama-cpp-server-timings';
import { createMetricsReporter, createReceivedTextMeter } from '@/logic/generation-metrics/measurement';
import type { GenerationMetrics } from '@/01-models/generation-metrics';
import { createOpenAiGenerationMetricsReader } from './openai-generation-metrics';
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
import { isUnsupportedReasoningError, UnsupportedReasoningError } from '@/01-models/lm-errors';
import { isReasoningErrorEnvelope, isReasoningRejection } from './reasoning-rejection';
import { z } from 'zod';
import { toToolCallId, type BinaryObjectId } from '@/01-models/ids';
import type { LmParameters, ChatMessage, LlamaCppServerTimingsMode } from '@/01-models/types';
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
  timings_per_token?: true,
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
    llamaCppServerTimings: LlamaCppServerTimingsMode,
  };

  constructor({ endpoint, headers, fetcher, llamaCppServerTimings = 'disabled' }: { endpoint: string, headers?: [string, string][], fetcher?: LmFetch, llamaCppServerTimings?: LlamaCppServerTimingsMode }) {
    this.config = { endpoint, headers, fetcher: fetcher ?? getDefaultLmFetch(), llamaCppServerTimings };
  }

  chat({ messages, model, parameters, tools, readBinaryObject, onGenerationMetrics, signal }: {
    messages: readonly ChatMessage[],
    model: string,
    parameters: LmParameters | undefined,
    tools: Parameters<LmProvider['chat']>[0]['tools'],
    onGenerationMetrics?: Parameters<LmProvider['chat']>[0]['onGenerationMetrics'],
    readBinaryObject: (({ binaryObjectId, signal }: { binaryObjectId: BinaryObjectId, signal: AbortSignal | undefined }) => Promise<Blob>) | undefined,
    signal: AbortSignal | undefined,
  }): AsyncIterable<ChatGenerationItem> {
    const snapshot = snapshotChatRequest({ messages, parameters, tools });
    const { endpoint, headers, fetcher, llamaCppServerTimings } = this.config;
    const requestHeaders = headers?.map(([name, value]): [string, string] => [name, value]);
    return createChatGenerationStream({
      signal,
      run: async ({ writer, signal }) => {
        const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
        const body: OpenAICompletionRequest = {
          model,
          messages: await buildApiChatMessages({ messages: snapshot.messages, readBinaryObject, signal }),
          stream: true,
        };
        if (snapshot.parameters) {
          const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...unhandled } = snapshot.parameters;
        unhandled satisfies Record<PropertyKey, never>;
        body.temperature = temperature;
        body.top_p = topP;
        body.max_completion_tokens = maxCompletionTokens;
        body.presence_penalty = presencePenalty;
        body.frequency_penalty = frequencyPenalty;
        body.stop = stop;
        body.reasoning_effort = reasoning.effort;
        }
        if (snapshot.tools?.length) {
          body.tools = snapshot.tools.map(tool => ({ type: 'function', function: tool }));
        }
        if (onGenerationMetrics !== undefined && await resolveLlamaCppServerTimings({ mode: llamaCppServerTimings, endpoint, headers: requestHeaders, fetcher, signal })) {
          body.timings_per_token = true;
        }
        signal.throwIfAborted();
        const requestStartedAt = performance.now();
        let response: Response;
        try {
          response = await fetcher(url, {
            method: 'POST',
            headers: [['Content-Type', 'application/json'], ...(requestHeaders ?? [])],
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          const message = `Network error or CORS issue: ${error instanceof Error ? error.message : String(error)}. Please check if the server is running and your endpoint URL is correct.`;
          addErrorEvent({ source: 'OpenAIProvider', message, details: { error, url, method: 'POST' } });
          throw new Error(message);
        }
        if (!response.ok) {
          const unsupportedReasoning = body.reasoning_effort === 'none' && await isReasoningRejection({ response, parameter: 'reasoning_effort' });
          const message = `OpenAI API Error (${response.status}): ${await readApiErrorDetails({ response })}`;
          if (unsupportedReasoning) {
            throw new UnsupportedReasoningError({ message });
          }
          addErrorEvent({ source: 'OpenAIProvider', message, details: { status: response.status, url } });
          throw new Error(message);
        }
        const textMeter = createReceivedTextMeter();
        const metricsReader = createOpenAiGenerationMetricsReader();
        const report = createMetricsReporter({ observer: onGenerationMetrics });
        // This controller owns only the optional statistics tail, not the generation request.
        const tailController = new AbortController();
        const readSignal = AbortSignal.any([signal, tailController.signal]);
        let tailTimer: ReturnType<typeof setTimeout> | undefined;
        let terminal: ChatGenerationResult | undefined;
        let terminalAt = 0;
        let finalMetrics: GenerationMetrics | undefined;
        let hasLiveServerMetrics = false;
        function reportLive({ metrics, receivedText = false }: { metrics: GenerationMetrics | undefined, receivedText?: boolean }): void {
          if (metrics !== undefined) {
            const force = !hasLiveServerMetrics;
            hasLiveServerMetrics = true;
            report({ metrics, force });
          } else if (!metricsReader.hasNativeTiming() && receivedText) {
            report({ metrics: textMeter.snapshot() });
          }
        }
        let nTailEvents = 0;
        let nTailCodeUnits = 0;
        function finish({ result }: { result: ChatGenerationResult }): ChatGenerationResult {
          const generationMetrics = finalMetrics ?? (metricsReader.hasNativeTiming() ? undefined : textMeter.snapshot());
          if (generationMetrics === undefined) {
            return result;
          }
          switch (result.type) {
          case 'finished': return { ...result, generationMetrics };
          case 'interrupted':
            return result.reason === 'limit' || result.reason === 'stop_sequence' ? { ...result, generationMetrics } : result;
          case 'error': return result;
          default: {
            const exhaustive: never = result;
            throw new Error(String(exhaustive));
          }
          }
        }
        const drafts: { key: number, id: string | undefined, name: string, arguments: string }[] = [];
        const currentByIndex = new Map<number, typeof drafts[number]>();
        async function completeCalls(): Promise<void> {
          const ids = new Set<string>();
          for (const call of drafts) {
            if (!call.id || !call.name || ids.has(call.id)) {
              throw new Error('Incomplete or duplicate tool call in a completed response.');
            }
            ids.add(call.id);
          }
          for (const call of drafts) {
          // A terminal API event, not successful JSON parsing, completes this call.
            await writer.call({ key: call.key, toolCall: { id: toToolCallId({ raw: call.id! }), type: 'function', function: { name: call.name, arguments: call.arguments } } });
          }
        }
        try {
          for await (const data of readSseData({ response, signal: readSignal })) {
            const receivedAt = performance.now();
            if (data === '[DONE]') {
              if (terminal !== undefined) {
                return finish({ result: terminal });
              }
              await completeCalls();
              return finish({ result: { type: 'finished', next: drafts.length ? 'tool_results' : 'user' } });
            }
            if (terminal !== undefined) {
              // After semantic completion, never append content or execute another call.
              nTailCodeUnits += data.length;
              if (++nTailEvents > 16 || nTailCodeUnits > 256 * 1024) {
                return finish({ result: terminal });
              }
              const raw: unknown = JSON.parse(data);
              const metadataOnly = z.object({ choices: z.array(z.unknown()).length(0) }).safeParse(raw);
              if (metadataOnly.success) {
                const metrics = metricsReader.final({ value: raw, requestDurationMs: terminalAt - requestStartedAt });
                if (metrics !== undefined) {
                  finalMetrics = metrics ?? undefined;
                  const measurement = metrics?.speed.measurement;
                  switch (measurement) {
                  case 'llama_cpp_predicted': return finish({ result: terminal });
                  case 'ollama_eval': case 'worker_sample_interval': case 'client_request': case 'received_text': case undefined: break;
                  default: {
                    const exhaustive: never = measurement;
                    throw new Error(String(exhaustive));
                  }
                  }
                }
              }
              continue;
            }
            const raw: unknown = JSON.parse(data);
            if (body.reasoning_effort === 'none' && isReasoningErrorEnvelope({ value: raw, parameter: 'reasoning_effort' })) {
              throw new UnsupportedReasoningError({ message: 'The endpoint rejected reasoning_effort=none in its generation stream.' });
            }
            const chunk = OpenAIChatChunkSchema.parse(raw);
            if (chunk.choices.length > 1) {
              throw new Error('Multiple generated choices are not supported in one assistant message.');
            }
            const choice = chunk.choices[0];
            if (!choice) {
              // Some compatible endpoints send their metadata before [DONE].
              const liveMetrics = metricsReader.live({ value: raw, now: receivedAt });
              reportLive({ metrics: liveMetrics });
              const provisional = metricsReader.final({ value: raw, requestDurationMs: receivedAt - requestStartedAt });
              if (provisional !== undefined) {
                finalMetrics = provisional ?? undefined;
              }
              continue;
            }
            // A subsequent choice invalidates any earlier metadata-only provisional total.
            // Only a terminal choice or the metadata immediately preceding [DONE] can seal it.
            finalMetrics = undefined;
            if (choice.index !== undefined && choice.index !== 0) {
              throw new Error('Unexpected choice index.');
            }
            const delta = choice.delta;
            let receivedText = false;
            if (delta) {
              if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning !== delta.reasoning_content) {
                throw new Error('Conflicting reasoning fields in the same response chunk.');
              }
              const reasoning = delta.reasoning ?? delta.reasoning_content;
              const fields = [
                { key: 'reasoning', text: reasoning ?? '' },
                { key: 'content', text: delta.content ?? '' },
                ...(delta.tool_calls ?? []).map(piece => ({ key: `tool-${piece.index}`, text: piece.function?.arguments ?? '' })),
              ];
              receivedText = fields.some(field => field.text.length > 0);
              textMeter.observe({ now: receivedAt, fields });
              // Empty deltas are API keep-alives/placeholders, not declared empty parts.
              if (reasoning) {
                await writer.text({ type: 'reasoning', text: reasoning });
              }
              if (delta.content) {
                await writer.text({ type: 'text', text: delta.content });
              }
              for (const piece of delta.tool_calls ?? []) {
                let draft = currentByIndex.get(piece.index);
                if (!draft || (piece.id && draft.id && draft.id !== piece.id)) {
                  draft = { key: drafts.length, id: piece.id, name: '', arguments: '' };
                  drafts.push(draft);
                  currentByIndex.set(piece.index, draft);
                  writer.reserveCall({ key: draft.key });
                }
                if (piece.id) {
                  draft.id = piece.id;
                }
                // Delta text is never deduplicated because two equal fragments can be intentional.
                const argumentsOffset = draft.arguments.length;
                draft.name += piece.function?.name ?? '';
                draft.arguments += piece.function?.arguments ?? '';
                await writer.callDraft({
                  key: draft.key,
                  name: piece.function?.name === undefined ? undefined : draft.name,
                  arguments: piece.function?.arguments === undefined ? undefined : { offset: argumentsOffset, text: piece.function.arguments },
                });
              }
            }
            if (choice.finish_reason === undefined || choice.finish_reason === null) {
              reportLive({ metrics: metricsReader.live({ value: raw, now: receivedAt }), receivedText });
            }
            if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
              terminalAt = receivedAt;
              finalMetrics = metricsReader.final({ value: raw, requestDurationMs: terminalAt - requestStartedAt }) ?? undefined;
              switch (choice.finish_reason) {
              case 'stop':
              case 'tool_calls':
                await completeCalls();
                terminal = { type: 'finished', next: drafts.length ? 'tool_results' : 'user' };
                break;
              case 'length': terminal = { type: 'interrupted', reason: 'limit' };
                break;
              default: return { type: 'interrupted', reason: 'unknown' };
              }
              const finalMeasurement = finalMetrics?.speed.measurement;
              switch (finalMeasurement) {
              case 'llama_cpp_predicted': return finish({ result: terminal });
              case 'ollama_eval': case 'worker_sample_interval': case 'client_request': case 'received_text': case undefined: break;
              default: {
                const exhaustive: never = finalMeasurement;
                throw new Error(String(exhaustive));
              }
              }
              // No include_usage request and no retry: preserve compatibility. A trailing
              // metadata event is optional, so it must never hold up a completed answer.
              tailTimer = setTimeout(() => tailController.abort(), 200);
            }
          }
          // A socket closing before a semantic completion still means interruption.
          return terminal === undefined ? { type: 'interrupted', reason: 'unknown' } : finish({ result: terminal });
        } catch (error) {
          if (terminal !== undefined && !signal.aborted) {
            return finish({ result: terminal });
          }
          if (!signal.aborted && !isUnsupportedReasoningError({ error })) {
            addErrorEvent({ source: 'OpenAIProvider', message: 'Failed to read or validate the generation stream', details: { error: error instanceof Error ? error : String(error) } });
          }
          throw error;
        } finally {
          clearTimeout(tailTimer);
        }
      },
    });
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
