/* eslint-disable no-restricted-imports -- Worker-only strategy module intentionally depends on transformers.js runtime types. */
import {
  TextStreamer,
  StoppingCriteriaList,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';
import { ToolCallStreamParser } from './transformers-js-tool-call-parser';
import { Qwen3_5ToolCallParser } from './transformers-js-qwen3_5-tool-call-parser';
import { generateGptOss } from './transformers-js-gpt-oss';
import {
  applyQwen3_5ConversationState,
  buildQwen3_5NoToolContinuationPrompt,
  buildQwen3_5Prompt,
  extractQwen3_5ConversationState,
  isQwen3_5NoToolContinuationCandidate,
  isQwen3_5Model,
  sanitizeQwen3_5VisibleText,
  type Qwen3_5ReasoningMode,
  type Qwen3_5ConversationState,
} from './transformers-js-qwen3_5';
import type { WorkerToolDefinition } from './transformers-js.types';

type ModelOutput = Record<string, unknown>;

interface GenerationResult {
  past_key_values: unknown;
  sequences?: unknown;
}

interface TextGenerationModel extends PreTrainedModel {
  generate(inputs: Record<string, unknown>): Promise<GenerationResult & (ModelOutput | Tensor)>;
}

export interface WorkerGenerationRuntimeState {
  activeModelId: string | null;
  qwen3_5Processor: {
    (text: string): Promise<Record<string, unknown>>;
    batch_decode(sequences: unknown, options: { skip_special_tokens: boolean }): string[];
  } | null;
  gptOssPastKeyValues: unknown;
  qwen3_5PastKeyValues: unknown;
  qwen3_5ConversationState: Qwen3_5ConversationState | undefined;
}

interface GenerationStrategyContext {
  model: PreTrainedModel;
  tokenizer: PreTrainedTokenizer;
  messages: ChatMessage[];
  onChunk: (chunk: string) => void;
  onToolCalls: (toolCalls: ToolCall[]) => void;
  params: LmParameters | undefined;
  tools: WorkerToolDefinition[] | undefined;
  runtimeState: WorkerGenerationRuntimeState;
  stoppingCriteria: {
    reset(): void;
    interrupt(): void;
  };
  debugLog: ({ event, details }: { event: string; details: Record<string, unknown> }) => void;
}

interface GenerationStrategy {
  kind: 'standard' | 'gpt-oss' | 'qwen3_5';
  generate(args: GenerationStrategyContext): Promise<void>;
}

export function selectGenerationStrategy({
  modelType,
  activeModelId,
  hasTools,
}: {
  modelType: string | undefined;
  activeModelId: string | null;
  hasTools: boolean;
}): GenerationStrategy {
  const isGptOss = activeModelId?.toLowerCase().includes('gpt-oss') ?? false;
  if (isGptOss && hasTools) {
    return gptOssGenerationStrategy;
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
    onToolCalls,
    params,
    tools,
    stoppingCriteria,
  }: GenerationStrategyContext) {
    const formattedMessages = messages.map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    }));

    const templateOptions: Record<string, unknown> = {
      add_generation_prompt: true,
      return_dict: true,
    };
    if (tools && tools.length > 0) {
      templateOptions['tools'] = tools;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = tokenizer.apply_chat_template(formattedMessages as any, templateOptions) as Record<string, unknown>;
    const toolCallParser = tools && tools.length > 0 ? new ToolCallStreamParser({ onText: onChunk }) : null;
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (output: string) => {
        if (toolCallParser) {
          toolCallParser.feed({ output });
        } else {
          onChunk(output);
        }
      },
    });

    const result = await generateWithModel({
      model,
      inputs,
      pastKeyValues: null,
      params,
      streamer,
      stoppingCriteria,
    });

    if (toolCallParser) {
      toolCallParser.flush();
      const parsedToolCalls = toolCallParser.drainToolCalls();
      if (parsedToolCalls.length > 0) onToolCalls(parsedToolCalls);
    }
    void result;
  },
};

const gptOssGenerationStrategy: GenerationStrategy = {
  kind: 'gpt-oss',
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
  }: GenerationStrategyContext) {
    runtimeState.gptOssPastKeyValues = await generateGptOss({
      model,
      tokenizer,
      messages,
      onChunk,
      onToolCalls,
      params,
      tools,
      pastKeyValues: runtimeState.gptOssPastKeyValues,
      stoppingCriteria,
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
      }),
    });
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
  }: GenerationStrategyContext) {
    if (!runtimeState.qwen3_5Processor) {
      throw new Error('Qwen3.5 processor not loaded');
    }
    const reasoningMode = getQwen3_5ReasoningMode({ params });

    const useNoToolContinuation = !tools?.length && isQwen3_5NoToolContinuationCandidate({
      messages,
      conversationState: runtimeState.qwen3_5ConversationState,
      activeModelId: runtimeState.activeModelId,
    }) && runtimeState.qwen3_5PastKeyValues !== null;

    const prompt = useNoToolContinuation
      ? buildQwen3_5NoToolContinuationPrompt({
        promptHistory: runtimeState.qwen3_5ConversationState!.promptHistory,
        message: messages.at(-1)!,
        reasoningMode,
      })
      : buildQwen3_5Prompt({ messages, tools, reasoningMode });

    // Qwen3.5-WebGPU uses promptHistory + past_key_values for normal chat turns.
    // That keeps no-tool conversations responsive. Tool turns stay on the full
    // prompt path until we have a serializer that matches tool continuations exactly.
    const inputs = applyQwen3_5ConversationState({
      inputs: await runtimeState.qwen3_5Processor(prompt),
      conversationState: runtimeState.qwen3_5ConversationState,
    });

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

    const toolCallParser = new Qwen3_5ToolCallParser({
      onText: (text) => {
        const sanitized = sanitizeQwen3_5VisibleText({ text });
        if (sanitized.length > 0) {
          onChunk(sanitized);
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
      pastKeyValues: useNoToolContinuation ? runtimeState.qwen3_5PastKeyValues : null,
      params,
      streamer,
      stoppingCriteria,
    });

    toolCallParser.flush();
    const parsedToolCalls = toolCallParser.drainToolCalls();
    if (parsedToolCalls.length > 0) onToolCalls(parsedToolCalls);

    runtimeState.qwen3_5PastKeyValues = result.past_key_values;
    runtimeState.qwen3_5ConversationState = extractQwen3_5ConversationState({
      modelId: runtimeState.activeModelId ?? '',
      promptHistory: runtimeState.qwen3_5Processor.batch_decode(result.sequences, {
        skip_special_tokens: false,
      })[0] ?? '',
      messageCount: messages.length,
      imageGridThw: inputs['image_grid_thw'],
      videoGridThw: inputs['video_grid_thw'],
    });
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
}: {
  model: PreTrainedModel;
  inputs: Record<string, unknown>;
  pastKeyValues: unknown;
  params: LmParameters | undefined;
  streamer: TextStreamer;
  stoppingCriteria: {
    reset(): void;
    interrupt(): void;
  };
}): Promise<GenerationResult & (ModelOutput | Tensor)> {
  const stoppingCriteriaList = new StoppingCriteriaList();
  stoppingCriteriaList.push(stoppingCriteria as never);

  return await (model as unknown as TextGenerationModel).generate({
    ...inputs,
    past_key_values: pastKeyValues,
    max_new_tokens: params?.maxCompletionTokens || 1024,
    temperature: params?.temperature ?? 0.6,
    top_p: params?.topP ?? 0.9,
    do_sample: (params?.temperature ?? 0.6) > 0,
    streamer,
    stopping_criteria: stoppingCriteriaList,
    return_dict_in_generate: true,
  });
}

function getQwen3_5ReasoningMode({
  params,
}: {
  params: LmParameters | undefined;
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
