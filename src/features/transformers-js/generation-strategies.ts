/* eslint-disable no-restricted-imports -- Worker-only strategy module intentionally depends on transformers.js runtime types. */
import {
  TextStreamer,
  RawImage,
  StoppingCriteriaList,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  Tensor,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import {
  buildGemma4TemplateInput,
  getGemma4ThinkingTemplateOptions,
  validateGemma4ToolCallsForTemplate,
  validateGemma4ToolName,
  isGemma4Model,
  type Gemma4ProcessorLike,
} from './models/gemma4';
import { Gemma4ToolCallParser } from './models/gemma4-tool-call-parser';
import { Qwen3_5ToolCallParser } from './models/qwen3_5-tool-call-parser';
import { generateGptOss } from './models/gpt-oss';
import {
  normalizeQwen3_5ProcessorInputs,
  buildQwen3_5Prompt,
  assessQwen3_5NoToolContinuationEligibility,
  isQwen3_5Model,
  sanitizeQwen3_5VisibleText,
  type Qwen3_5ReasoningMode,
  type Qwen3_5ConversationState,
} from './models/qwen3_5';
import { canReuseQwenSequenceCache, retainQwenSequenceCache, type QwenSequenceCache } from './models/qwen3_5-cache';
import type { WorkerToolDefinition } from './types';
import { recordGenerationCapture, type GenerationCaptureCall } from './worker/generation-capture';
import { observeNativeStreamer } from './worker/native-streamer-capture';
import { resolveGenerationBudget, type GenerationBudget } from './generation-budget';
import {
  createReasoningStreamNormalizer,
  detectReasoningStreamProtocol,
  type ReasoningStreamProtocol,
} from './reasoning-stream-protocol';
import {
  createStandardToolCallStreamParser,
  resolveStandardToolHandling,
  formatStandardMessagesForToolHandling,
  validateStandardToolCallsForHandling,
  type StandardToolHandling,
} from './standard-tool-call-protocol';
import { createToolStreamDecodeView } from './standard-tool-stream-decoder';

type ModelOutput = Record<string, unknown>;

interface GenerationResult {
  past_key_values: unknown,
  sequences?: unknown,
}

export type GenerationStrategyCacheDecision =
  | { status: 'reused' | 'not-reused' | 'not-applicable', reason: string }
  | { status: 'unavailable', reason: string };

type GenerationInvocationProperty = Readonly<
  | { status: 'omitted' | 'undefined' | 'null' }
  | { status: 'value', value: number | boolean }
  | { status: 'not-recorded', reason: 'accessor' | 'unsupported-value' | 'non-finite-number' }
>;

export type GenerationInvocationObservation = {
  // Own-property descriptors at native-call time, not a saved public request.
  readonly requested: {
    readonly maxCompletionTokens: GenerationInvocationProperty,
    readonly temperature: GenerationInvocationProperty,
    readonly topP: GenerationInvocationProperty,
  },
  readonly budget: Readonly<GenerationBudget>,
  readonly kwargs: {
    readonly keys: {
      readonly status: 'complete' | 'incomplete',
      readonly totalCount: number,
      readonly values: readonly string[],
      readonly incompleteReasons: readonly ('key-count-limit' | 'key-length-limit' | 'symbol-key')[],
    },
    readonly maxNewTokens: GenerationInvocationProperty,
    readonly temperature: GenerationInvocationProperty,
    readonly topP: GenerationInvocationProperty,
    readonly doSample: GenerationInvocationProperty,
    readonly returnDictInGenerate: GenerationInvocationProperty,
  },
};

export interface GenerationStrategyObservationSink {
  onFullConversationInputPrepared({ inputs, cacheDecision }: {
    inputs: Record<string, unknown>,
    cacheDecision: GenerationStrategyCacheDecision,
  }): void,
  onGenerateStart({ inputs, pastKeyValues }: {
    inputs: Record<string, unknown>,
    pastKeyValues: unknown,
  }): void,
  // Only this invocation-setting event owns a detached, frozen projection.
  // Earlier input and later result events retain their existing live views.
  onGenerateInvocation({ observation }: { observation: GenerationInvocationObservation }): void,
  onGenerateComplete({ result }: {
    result: GenerationResult & (ModelOutput | Tensor),
  }): void,
}

function snapshotInvocationProperty({ object, key }: {
  object: object | undefined,
  key: string,
}): GenerationInvocationProperty {
  const descriptor = object === undefined ? undefined : Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return Object.freeze({ status: 'omitted' });
  if (!Object.hasOwn(descriptor, 'value')) return Object.freeze({ status: 'not-recorded', reason: 'accessor' });
  const value: unknown = descriptor.value;
  if (value === undefined) return Object.freeze({ status: 'undefined' });
  if (value === null) return Object.freeze({ status: 'null' });
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Object.freeze({ status: 'not-recorded', reason: 'non-finite-number' });
  }
  if (typeof value === 'number' || typeof value === 'boolean') return Object.freeze({ status: 'value', value });
  // Required settings are numeric/boolean. Do not copy arbitrary strings or
  // objects, traverse a prototype, or execute getters just for diagnostics.
  return Object.freeze({ status: 'not-recorded', reason: 'unsupported-value' });
}

function snapshotGenerationInvocation({ params, generationBudget, kwargs }: {
  params: LmParameters | undefined,
  generationBudget: GenerationBudget,
  kwargs: Record<string, unknown>,
}): GenerationInvocationObservation {
  const ownKeys = Reflect.ownKeys(kwargs);
  const keys: string[] = [];
  const incompleteReasons = new Set<'key-count-limit' | 'key-length-limit' | 'symbol-key'>();
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      incompleteReasons.add('symbol-key');
    } else if (key.length > 128) {
      incompleteReasons.add('key-length-limit');
    } else if (keys.length >= 64) {
      incompleteReasons.add('key-count-limit');
    } else {
      keys.push(key);
    }
  }
  // This bounds retained setting/key data only, not a full invocation trace.
  // Unknown keys remain visible within the limit; their values, Tensor/KV
  // contents, streamer and stopping criteria are deliberately not exposed.
  return Object.freeze({
    requested: Object.freeze({
      maxCompletionTokens: snapshotInvocationProperty({ object: params, key: 'maxCompletionTokens' }),
      temperature: snapshotInvocationProperty({ object: params, key: 'temperature' }),
      topP: snapshotInvocationProperty({ object: params, key: 'topP' }),
    }),
    budget: Object.freeze({ ...generationBudget }),
    kwargs: Object.freeze({
      keys: Object.freeze({
        status: incompleteReasons.size === 0 ? 'complete' : 'incomplete',
        totalCount: ownKeys.length,
        values: Object.freeze(keys),
        incompleteReasons: Object.freeze([...incompleteReasons]),
      }),
      maxNewTokens: snapshotInvocationProperty({ object: kwargs, key: 'max_new_tokens' }),
      temperature: snapshotInvocationProperty({ object: kwargs, key: 'temperature' }),
      topP: snapshotInvocationProperty({ object: kwargs, key: 'top_p' }),
      doSample: snapshotInvocationProperty({ object: kwargs, key: 'do_sample' }),
      returnDictInGenerate: snapshotInvocationProperty({ object: kwargs, key: 'return_dict_in_generate' }),
    }),
  });
}

function emitGenerationObservation({
  observationSink,
  emit,
}: {
  observationSink: GenerationStrategyObservationSink | undefined,
  emit: ({ sink }: { sink: GenerationStrategyObservationSink }) => void,
}): void {
  if (observationSink === undefined) return;
  try {
    emit({ sink: observationSink });
  } catch {
    // Investigation instrumentation is diagnostic-only. A broken observer must
    // never change the Production generation result being measured.
  }
}

interface TextGenerationModel extends PreTrainedModel {
  generate(inputs: Record<string, unknown>): Promise<GenerationResult & (ModelOutput | Tensor)>,
}

export interface WorkerGenerationRuntimeState {
  activeModelId: string | null,
  gemma4Processor: Gemma4ProcessorLike | null,
  qwen3_5Processor: {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callable mirrors the Transformers processor signature.
    (text: string, images?: RawImage[]): Promise<Record<string, unknown>>,
  } | null,
  gptOssPastKeyValues: unknown,
  qwen3_5ConversationState: Qwen3_5ConversationState | undefined,
  generationStateOwner: object,
  qwen3_5SequenceCache: QwenSequenceCache | undefined,
}

interface GenerationStrategyContext {
  continuationOwner?: string,
  model: PreTrainedModel,
  tokenizer: PreTrainedTokenizer,
  messages: ChatMessage[],
  onChunk: ({ chunk }: { chunk: string }) => void,
  onRawChunk: ({ chunk }: { chunk: string }) => void,
  onToolCalls: ({ toolCalls }: { toolCalls: ToolCall[] }) => void,
  params: LmParameters | undefined,
  tools: WorkerToolDefinition[] | undefined,
  runtimeState: WorkerGenerationRuntimeState,
  stoppingCriteria: {
    reset(): void,
    interrupt(): void,
  },
  debugLog: ({ event, details }: { event: string, details: Record<string, unknown> }) => void,
  observationSink: GenerationStrategyObservationSink | undefined,
  generationCapture: GenerationCaptureCall | undefined,
}

export interface GenerationStrategy {
  kind: 'standard' | 'gpt-oss' | 'qwen3_5' | 'gemma4',
  generate({ model, tokenizer, messages, onChunk, onRawChunk, onToolCalls, params, tools, runtimeState, stoppingCriteria, debugLog, observationSink }: GenerationStrategyContext): Promise<void>,
}

function detectStandardReasoningProtocol({
  tokenizer,
  formattedMessages,
  templateOptions,
  debugLog,
}: {
  tokenizer: PreTrainedTokenizer,
  formattedMessages: Array<Record<string, unknown>>,
  templateOptions: Record<string, unknown>,
  debugLog: GenerationStrategyContext['debugLog'],
}): ReasoningStreamProtocol {
  try {
    const renderedGenerationPrompt = tokenizer.apply_chat_template(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transformers.js chat-template messages are structurally compatible with Naidan messages.
      formattedMessages as any,
      { ...templateOptions, tokenize: false, return_dict: false },
    );
    if (typeof renderedGenerationPrompt !== 'string') return 'generated-output';
    const preliminaryProtocol = detectReasoningStreamProtocol({
      renderedGenerationPrompt,
      renderedConversationPrompt: undefined,
    });
    switch (preliminaryProtocol) {
    case 'generated-output':
      return preliminaryProtocol;
    case 'prompt-open-think':
      break;
    default: {
      const _ex: never = preliminaryProtocol;
      throw new Error(`Unhandled reasoning stream protocol: ${String(_ex)}`);
    }
    }

    const renderedConversationPrompt = tokenizer.apply_chat_template(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transformers.js chat-template messages are structurally compatible with Naidan messages.
      formattedMessages as any,
      { ...templateOptions, add_generation_prompt: false, tokenize: false, return_dict: false },
    );
    if (typeof renderedConversationPrompt !== 'string') return 'generated-output';
    return detectReasoningStreamProtocol({
      renderedGenerationPrompt,
      renderedConversationPrompt,
    });
  } catch (error) {
    debugLog({
      event: 'standard reasoning protocol observation unavailable',
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return 'generated-output';
  }
}

export function selectGenerationStrategy({
  modelType,
  activeModelId,
}: {
  modelType: string | undefined,
  activeModelId: string | null,
}): GenerationStrategy {
  // Harmony is the model's output protocol even when no tools are available.
  // The standard streamer strips its control tokens and merges analysis into
  // visible text, so tool availability must not select the output interpreter.
  const isGptOss = modelType === 'gpt_oss' || (activeModelId?.toLowerCase().includes('gpt-oss') ?? false);
  if (isGptOss) {
    return gptOssGenerationStrategy;
  }
  if (isGemma4Model({ modelType, activeModelId })) {
    return gemma4GenerationStrategy;
  }
  if (isQwen3_5Model({ modelType, activeModelId })) {
    return qwen3_5GenerationStrategy;
  }
  return standardGenerationStrategy;
}

const standardGenerationStrategy: GenerationStrategy = {
  kind: 'standard',
  async generate({
    model,
    tokenizer,
    messages,
    onChunk,
    onRawChunk,
    onToolCalls,
    params,
    tools,
    stoppingCriteria,
    debugLog,
    observationSink,
    generationCapture,
  }: GenerationStrategyContext) {
    const toolHandling: StandardToolHandling = tools && tools.length > 0
      ? resolveStandardToolHandling({ tokenizer, debugLog })
      : { outputProtocol: 'json-tagged', historyEncoding: 'native-template', preservedDelimiterIds: [] };
    const formattedMessages = formatStandardMessagesForToolHandling({
      messages,
      handling: toolHandling,
    });

    const templateOptions: Record<string, unknown> = {
      add_generation_prompt: true,
      return_dict: true,
    };
    if (tools && tools.length > 0) {
      templateOptions['tools'] = tools;
    }

    const reasoningProtocol = detectStandardReasoningProtocol({
      tokenizer,
      formattedMessages,
      templateOptions,
      debugLog,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = tokenizer.apply_chat_template(formattedMessages as any, templateOptions) as Record<string, unknown>;
    emitGenerationObservation({
      observationSink,
      emit: ({ sink }) => sink.onFullConversationInputPrepared({
        inputs,
        cacheDecision: {
          status: 'not-applicable',
          reason: 'standard-strategy-does-not-use-past-key-values',
        },
      }),
    });
    let assistantContent = '';
    const toolCallParser = tools && tools.length > 0
      ? createStandardToolCallStreamParser({
        protocol: toolHandling.outputProtocol,
        tools,
        onText: ({ text }) => {
          // Admit the complete text the Provider will put back into history,
          // including control-token prefixes split across stream chunks.
          assistantContent += text;
          onChunk({ chunk: text });
        },
      })
      : null;
    const reasoningStream = createReasoningStreamNormalizer({
      protocol: reasoningProtocol,
      onOutput: ({ output }) => {
        if (toolCallParser) {
          toolCallParser.feed({ output });
        } else {
          onChunk({ chunk: output });
        }
      },
    });
    const streamTokenizer = toolHandling.preservedDelimiterIds.length === 0 ? tokenizer
      : createToolStreamDecodeView({ tokenizer, preservedDelimiterIds: toolHandling.preservedDelimiterIds });
    const streamer = new TextStreamer(streamTokenizer, {
      skip_prompt: true,
      skip_special_tokens: toolHandling.preservedDelimiterIds.length === 0,
      callback_function: (output: string) => {
        onRawChunk({ chunk: output });
        reasoningStream.feed({ output });
      },
    });

    const result = await generateWithModel({
      model,
      inputs,
      pastKeyValues: null,
      params,
      streamer,
      stoppingCriteria,
      observationSink,
      generationCapture,
    });

    reasoningStream.flush();
    if (toolCallParser) {
      toolCallParser.flush();
      const parsedToolCalls = toolCallParser.drainToolCalls();
      validateStandardToolCallsForHandling({ toolCalls: parsedToolCalls, handling: toolHandling, assistantContent });
      if (parsedToolCalls.length > 0) onToolCalls({ toolCalls: parsedToolCalls });
    }
    void result;
  },
};

const gptOssGenerationStrategy: GenerationStrategy = {
  kind: 'gpt-oss',
  async generate({
    continuationOwner,
    model,
    tokenizer,
    messages,
    onChunk,
    onToolCalls,
    params,
    tools,
    runtimeState,
    stoppingCriteria,
    observationSink,
    generationCapture,
  }: GenerationStrategyContext) {
    const stateOwner = runtimeState.generationStateOwner;
    const previousCache = runtimeState.gptOssPastKeyValues;
    runtimeState.gptOssPastKeyValues = null;
    const generatedCache = await generateGptOss({
      model,
      tokenizer,
      messages,
      onChunk,
      onToolCalls,
      params,
      tools,
      pastKeyValues: previousCache,
      continuationOwner,
      stoppingCriteria,
      onInputPrepared: observationSink === undefined
        ? undefined
        : ({ fullConversationInputs, cacheDecision }) => {
          emitGenerationObservation({
            observationSink,
            emit: ({ sink }) => sink.onFullConversationInputPrepared({
              inputs: fullConversationInputs,
              cacheDecision,
            }),
          });
        },
      generateWithModel: async ({
        model,
        inputs,
        pastKeyValues,
        params,
        streamer,
        stoppingCriteria,
      }) => await generateWithModel({
        model,
        inputs,
        pastKeyValues,
        params,
        streamer,
        stoppingCriteria,
        observationSink,
        generationCapture,
      }),
    });
    if (runtimeState.generationStateOwner === stateOwner) runtimeState.gptOssPastKeyValues = generatedCache;
  },
};

const gemma4GenerationStrategy: GenerationStrategy = {
  kind: 'gemma4',
  async generate({
    model,
    tokenizer,
    messages,
    onChunk,
    onToolCalls,
    params,
    tools,
    runtimeState,
    stoppingCriteria,
    debugLog,
    observationSink,
    generationCapture,
  }: GenerationStrategyContext) {
    if (!runtimeState.gemma4Processor) {
      throw new Error('Gemma 4 processor not loaded');
    }

    for (const tool of tools ?? []) validateGemma4ToolName({ name: tool.function.name });
    const { images, templateMessages } = await buildGemma4TemplateInput({ messages });
    const prompt = runtimeState.gemma4Processor.apply_chat_template(templateMessages, {
      add_generation_prompt: true,
      ...getGemma4ThinkingTemplateOptions({ parameters: params }),
      ...(tools?.length ? { tools } : {}),
    });
    const inputs = await runtimeState.gemma4Processor(
      prompt,
      images.length > 0 ? images : null,
      null,
      { add_special_tokens: false },
    );
    emitGenerationObservation({
      observationSink,
      emit: ({ sink }) => sink.onFullConversationInputPrepared({
        inputs,
        cacheDecision: {
          status: 'not-applicable',
          reason: 'gemma4-strategy-does-not-use-past-key-values',
        },
      }),
    });
    let rawChunkIndex = 0;
    let rawStreamOutput = '';

    debugLog({
      event: 'gemma4 input shape',
      details: {
        activeModelId: runtimeState.activeModelId,
        messageCount: messages.length,
        imageCount: images.length,
        inputKeys: Object.keys(inputs).sort(),
      },
    });

    const toolParser = new Gemma4ToolCallParser({
      onText: ({ text }) => onChunk({ chunk: text }), toolCalls: tools?.length ? 'enabled' : 'disabled',
      ignoredSpecialTokens: tokenizer.all_special_ids.map(id => tokenizer.decode([id], { skip_special_tokens: false })),
    });
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (output: string) => {
        rawChunkIndex += 1;
        rawStreamOutput += output;
        console.log('[transformersJsWorker] gemma4 raw chunk:', JSON.stringify({
          index: rawChunkIndex,
          output,
        }));
        toolParser.feed({ output });
      },
    });

    let result: Awaited<ReturnType<typeof generateWithModel>>;
    try {
      result = await generateWithModel({
        model,
        inputs,
        pastKeyValues: null,
        params,
        streamer,
        stoppingCriteria,
        observationSink,
        generationCapture,
      });
      toolParser.flush();
    } catch (error) {
      toolParser.abort();
      throw error;
    }
    const toolCalls = toolParser.drainToolCalls();
    // Validate the whole batch before publishing any executable call. Native
    // syntax can express values that its history template cannot preserve.
    validateGemma4ToolCallsForTemplate({ toolCalls });
    if (toolCalls.length > 0) onToolCalls({ toolCalls });
    console.log('[transformersJsWorker] gemma4 raw output start');
    console.log(rawStreamOutput);
    console.log('[transformersJsWorker] gemma4 raw output end');
    debugLog({
      event: 'gemma4 raw output summary',
      details: {
        activeModelId: runtimeState.activeModelId,
        rawChunkCount: rawChunkIndex,
        rawOutputLength: rawStreamOutput.length,
      },
    });
    void result;
  },
};

const qwen3_5GenerationStrategy: GenerationStrategy = {
  kind: 'qwen3_5',
  async generate({
    model,
    tokenizer,
    messages,
    onChunk,
    onToolCalls,
    params,
    tools,
    runtimeState,
    stoppingCriteria,
    debugLog,
    observationSink,
    generationCapture,
  }: GenerationStrategyContext) {
    if (!runtimeState.qwen3_5Processor) {
      throw new Error('Qwen3.5 processor not loaded');
    }
    const reasoningMode = getQwen3_5ReasoningMode({ params });
    const cacheGeneration = runtimeState.generationStateOwner;
    const sequenceCache = runtimeState.qwen3_5SequenceCache;

    const continuationEligibility = assessQwen3_5NoToolContinuationEligibility({
      messages,
      conversationState: runtimeState.qwen3_5ConversationState,
      activeModelId: runtimeState.activeModelId,
    });
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    if (hasImages && model.sessions['vision_encoder'] === undefined) {
      throw new Error('This Qwen runtime was loaded from a text-only local candidate. Image generation requires a complete vision candidate and an explicit model reload; offline generation will not download or load additional model files.');
    }
    // Consume the old pair before asynchronous work: native generation can
    // mutate a supplied cache in place, even when it later rejects.
    runtimeState.qwen3_5SequenceCache = undefined;
    runtimeState.qwen3_5ConversationState = undefined;
    const prompt = buildQwen3_5Prompt({ messages, tools, reasoningMode, tokenizer });
    // Native templates depend on the complete history, not independently
    // rendered message suffixes. Prepare the full input exactly once.
    const images: RawImage[] = [];
    for (const message of messages) {
      if (typeof message.content === 'string') continue;
      for (const part of message.content) {
        switch (part.type) {
        case 'text': break;
        case 'image_url': images.push(await RawImage.read(part.image_url.url)); break;
        default: { const exhaustive: never = part; throw new Error(`Unhandled Qwen content part: ${String(exhaustive)}`); }
        }
      }
    }
    const processedInputs = images.length === 0
      ? await runtimeState.qwen3_5Processor(prompt)
      : await runtimeState.qwen3_5Processor(prompt, images);
    const inputs = normalizeQwen3_5ProcessorInputs({
      inputs: processedInputs,
    });
    const useNoToolContinuation = !tools?.length && !hasImages
      && continuationEligibility.status === 'eligible'
      && runtimeState.generationStateOwner === cacheGeneration
      && canReuseQwenSequenceCache({ cache: sequenceCache, model, inputs, tensorClass: Tensor });
    if (observationSink !== undefined) {
      const cacheDecision: GenerationStrategyCacheDecision = (() => {
        if (hasImages) return { status: 'not-reused', reason: 'qwen3_5-image-cache-reuse-unverified' };
        if (tools?.length) {
          return { status: 'not-reused', reason: 'qwen3_5-tools-disable-no-tool-continuation' };
        }
        switch (continuationEligibility.status) {
        case 'eligible':
          return useNoToolContinuation
            ? { status: 'reused', reason: 'qwen3_5-verified-full-input-prefix' }
            : { status: 'not-reused', reason: 'qwen3_5-cache-prefix-or-native-preconditions-unverified' };
        case 'ineligible':
          return { status: 'not-reused', reason: `qwen3_5-${continuationEligibility.reason}` };
        default: {
          const _ex: never = continuationEligibility;
          return _ex;
        }
        }
      })();
      emitGenerationObservation({
        observationSink,
        emit: ({ sink }) => sink.onFullConversationInputPrepared({
          inputs: processedInputs,
          cacheDecision,
        }),
      });
    }

    debugLog({
      event: 'qwen prompt',
      details: {
        activeModelId: runtimeState.activeModelId,
        promptLength: prompt.length,
        messageCount: messages.length,
        usesNoToolContinuation: useNoToolContinuation,
        reasoningMode,
      },
    });

    debugLog({
      event: 'qwen input shape',
      details: {
        activeModelId: runtimeState.activeModelId,
        inputKeys: Object.keys(inputs).sort(),
        hasPixelValues: 'pixel_values' in inputs,
        hasImageGridThwInput: 'image_grid_thw' in inputs,
      },
    });

    // Recognize the known native assistant generation header, not effort or a
    // bare thinking suffix. Unknown custom prompt formats remain unchanged.
    // Reuse this exact prompt: another render must not alter native inputs.
    const reasoningStream = createReasoningStreamNormalizer({
      protocol: prompt.trimEnd().endsWith(`\
<|im_start|>assistant
<think>`)
        ? detectReasoningStreamProtocol({ renderedGenerationPrompt: prompt, renderedConversationPrompt: undefined })
        : 'generated-output',
      onOutput: ({ output }) => onChunk({ chunk: output }),
    });
    const toolCallParser = new Qwen3_5ToolCallParser({
      tools,
      onText: ({ text }) => {
        const sanitized = sanitizeQwen3_5VisibleText({ text });
        if (sanitized.length > 0) {
          // Pure tool syntax is not assistant text and cannot cause an empty
          // synthetic opener to leak into the public response.
          reasoningStream.feed({ output: sanitized });
        }
      },
    });
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: reasoningMode !== 'enabled',
      callback_function: (output: string) => {
        toolCallParser.feed({ output });
      },
    });

    const result = await generateWithModel({
      model,
      inputs,
      pastKeyValues: useNoToolContinuation ? sequenceCache!.pastKeyValues : null,
      params,
      streamer,
      stoppingCriteria,
      observationSink,
      generationCapture,
    });

    toolCallParser.flush();
    reasoningStream.flush();
    const parsedToolCalls = toolCallParser.drainToolCalls();
    if (parsedToolCalls.length > 0) onToolCalls({ toolCalls: parsedToolCalls });

    // A reset, interrupt, replacement Load or later request revokes this
    // invocation's right to publish continuation state after its await.
    if (runtimeState.generationStateOwner !== cacheGeneration) return;
    runtimeState.qwen3_5SequenceCache = !hasImages && !tools?.length
      ? retainQwenSequenceCache({ model, sequences: result.sequences, pastKeyValues: result.past_key_values, inputs, tensorClass: Tensor })
      : undefined;
    runtimeState.qwen3_5ConversationState = {
      modelId: runtimeState.activeModelId ?? '',
      messageCount: messages.length,
    };
    void result;
  },
};

async function generateWithModel({
  model,
  inputs,
  pastKeyValues,
  params,
  streamer,
  stoppingCriteria,
  observationSink,
  generationCapture,
}: {
  model: PreTrainedModel,
  inputs: Record<string, unknown>,
  pastKeyValues: unknown,
  params: LmParameters | undefined,
  streamer: TextStreamer,
  stoppingCriteria: {
    reset(): void,
    interrupt(): void,
  },
  observationSink: GenerationStrategyObservationSink | undefined,
  generationCapture: GenerationCaptureCall | undefined,
}): Promise<GenerationResult & (ModelOutput | Tensor)> {
  const stoppingCriteriaList = new StoppingCriteriaList();
  stoppingCriteriaList.push(stoppingCriteria as never);

  emitGenerationObservation({
    observationSink,
    emit: ({ sink }) => sink.onGenerateStart({ inputs, pastKeyValues }),
  });
  let invocation: ReturnType<GenerationCaptureCall['beginInvocation']>;
  if (generationCapture !== undefined) {
    recordGenerationCapture({ record: () => {
      invocation = generationCapture.beginInvocation();
      invocation?.recordInputs({ phase: 'pre-budget', inputs });
    } });
  }
  const generationBudget = resolveGenerationBudget({
    modelConfig: model.config,
    inputs,
    pastKeyValues,
    maxCompletionTokens: params?.maxCompletionTokens,
  });
  const generationLength = generationBudget.maxNewTokens === undefined
    ? {}
    : { max_new_tokens: generationBudget.maxNewTokens };
  // Preserve method lookup before kwargs spread/getters, as in model.generate({...}).
  const nativeGenerate = (model as unknown as TextGenerationModel).generate;
  const kwargs = {
    ...inputs,
    past_key_values: pastKeyValues,
    ...generationLength,
    temperature: params?.temperature ?? 0.6,
    top_p: params?.topP ?? 0.9,
    do_sample: (params?.temperature ?? 0.6) > 0,
    streamer,
    stopping_criteria: stoppingCriteriaList,
    return_dict_in_generate: true,
  };
  emitGenerationObservation({
    observationSink,
    emit: ({ sink }) => sink.onGenerateInvocation({
      observation: snapshotGenerationInvocation({ params, generationBudget, kwargs }),
    }),
  });
  if (invocation !== undefined) {
    recordGenerationCapture({ record: () => {
      invocation?.recordSettings({ observation: snapshotGenerationInvocation({ params, generationBudget, kwargs }) });
      invocation?.recordInputs({ phase: 'native-kwargs', inputs: kwargs });
      invocation?.recordNativeCall({ phase: 'entering' });
    } });
  }
  // The observer receives no live kwargs references. Keep the original receiver,
  // a single native call, and the existing await boundary without an observer ACK.
  let nativeStreamHook: ReturnType<typeof observeNativeStreamer> | undefined;
  if (invocation !== undefined) {
    recordGenerationCapture({ record: () => {
      nativeStreamHook = observeNativeStreamer({ streamer, streamerPrototype: TextStreamer.prototype, capture: invocation });
    } });
  }
  let result: Awaited<ReturnType<TextGenerationModel['generate']>>;
  try {
    result = await (Reflect.apply(nativeGenerate, model, [kwargs]) as ReturnType<TextGenerationModel['generate']>);
  } catch (error) {
    if (invocation !== undefined) recordGenerationCapture({ record: () => invocation?.recordNativeCall({ phase: 'rejected' }) });
    throw error;
  } finally {
    if (nativeStreamHook !== undefined) recordGenerationCapture({ record: () => nativeStreamHook?.restore() });
  }
  if (invocation !== undefined) {
    recordGenerationCapture({ record: () => {
      invocation?.recordNativeCall({ phase: 'fulfilled' });
      invocation?.recordSequence({ result });
    } });
  }
  emitGenerationObservation({
    observationSink,
    emit: ({ sink }) => sink.onGenerateComplete({ result }),
  });
  return result;
}

function getQwen3_5ReasoningMode({
  params,
}: {
  params: LmParameters | undefined,
}): Qwen3_5ReasoningMode {
  const effort = params?.reasoning?.effort;
  switch (effort) {
  case undefined:
    return 'default';
  case 'none':
    return 'disabled';
  case 'low':
  case 'medium':
  case 'high':
    return 'enabled';
  default: {
    const exhaustive: never = effort;
    throw new Error(`Unhandled Qwen3.5 reasoning effort: ${exhaustive}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
