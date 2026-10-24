import { isUnsupportedReasoningError } from '@/01-models/lm-errors';
import { renderThinkingTemplate } from '@/features/lm/reasoning-rejection';
import type { MainModule, common_chat_params, common_chat_prompt, common_chat_templates_inputs, common_chat_msg } from 'llama-cpp-browser-core/profiles/webgpu-wasm64-jspi/browser/core.mjs';
import { LlamaCppBrowserError, type GenerateInput, type GenerationResult } from '@/features/llama-cpp-browser/types';
import { logFailure } from '@/features/llama-cpp-browser/debug-log';

// Only the chat result fields used by Naidan cross the profile boundary. In
// particular, size_t-backed JSON, arena and delimiter helpers remain native.
export type ChatParams = Pick<common_chat_params,
  'delete' | 'format' | 'grammar' | 'grammar_lazy' | 'generation_prompt'
  | 'supports_thinking' | 'thinking_start_tag' | 'thinking_end_tags'
  | 'grammar_triggers' | 'preserved_tokens' | 'additional_stops'>;
type ChatInputValues = Pick<common_chat_templates_inputs,
  'delete' | 'tools' | 'use_jinja' | 'parallel_tool_calls' | 'enable_thinking' | 'reasoning_format' | 'chat_template_kwargs'>;
export type ChatPromptPart = { text: string, isInput: boolean };
type ParsedMessage = Pick<common_chat_msg, 'delete' | 'tool_calls' | 'content' | 'reasoning_content'>;

/** Bind once to a concrete native module. The generic handles preserve the
 * relation between its constructors and consumers without pretending all
 * generated MainModule declarations have the wasm64 signature. No conversion
 * or cast of size_t, pointers, native handles or model-visible text occurs. */
// Generic signatures below mirror the generated Embind ABI, retaining each
// profile's handle relationships; they are not Naidan-owned callback contracts.
/* eslint-disable local-rules-named-args/require-named-args */
export function bindNativeChat<
  Json extends { delete(): void },
  Messages extends { delete(): void },
  Inputs extends ChatInputValues & { messages: Messages },
  Params extends ChatParams & { prompt: Pick<common_chat_prompt, 'delete' | 'parts'>, parser: Arena },
  Arena extends { delete(): void },
  Parser extends { delete(): void; parser: Arena },
  Input extends { delete(): void },
>({ native }: { native: Pick<MainModule, 'string_map' | 'common_reasoning_format'> & {
  common_json: { parse(text: string): Json };
  common_chat_msgs_parse_oaicompat(json: Json): Messages;
  common_chat_tools_parse_oaicompat(json: Json): ChatInputValues['tools'];
  common_chat_templates_inputs: new () => Inputs;
  common_chat_templates: new (model: bigint, chatTemplate: string, bosToken: string, eosToken: string) => { delete(): void; apply(inputs: Inputs): Params };
  common_chat_parser_params: new (params: Params) => Parser;
  common_chat_input: new (text: string) => Input;
  common_chat_parse(input: Input, partial: boolean, parser: Parser): ParsedMessage;
} }) {
  /* eslint-enable local-rules-named-args/require-named-args */
  const templatesByModel = new Map<bigint, InstanceType<typeof native.common_chat_templates>>();
  const templateFor = ({ assertIdle, model }: { assertIdle: () => void, model: bigint }) => {
    assertIdle();
    const existing = templatesByModel.get(model);
    if (existing) {
      return existing;
    }
    const created = new native.common_chat_templates(model, '', '', '');
    templatesByModel.set(model, created);
    return created;
  };
  return {
    releaseModel({ assertIdle, model }: { assertIdle: () => void, model: bigint }): void {
      assertIdle();
      const templates = templatesByModel.get(model);
      if (!templates) {
        return;
      }
      templatesByModel.delete(model);
      templates.delete();
    },
    prepare({ assertIdle, model, request }: { assertIdle: () => void, model: bigint, request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'> }) {
      assertIdle();
      let params: Params | undefined;
      let parser: Parser | undefined;
      const dispose = (): void => {
        // Release ownership before destructors run. A failed parser cleanup
        // must neither leak the parameters nor retry the same handle later.
        const ownedParser = parser;
        const ownedParams = params;
        parser = undefined;
        params = undefined;
        try {
          ownedParser?.delete();
        } finally {
          ownedParams?.delete();
        }
      };
      try {
        const templates = templateFor({ assertIdle, model });
        const images: { marker: string, blob: Blob }[] = [];
        const messages = request.messages.map(message => ({
          ...message,
          content: typeof message.content === 'string' ? message.content : message.content.map(part => {
            switch (part.type) {
            case 'text': return part;
            case 'image': {
            // An unpredictable marker keeps literal user text distinct from media.
              const marker = `<__image_${crypto.randomUUID()}__>`;
              images.push({ marker, blob: part.blob });
              return { type: 'media_marker', text: marker };
            }
            default: {
              const exhaustive: never = part;
              throw new Error(`Unknown part: ${exhaustive}`);
            }
            }
          }),
        }));
        const inputs = new native.common_chat_templates_inputs();
        try {
          const messagesJson = native.common_json.parse(JSON.stringify(messages));
          try {
            const messages = native.common_chat_msgs_parse_oaicompat(messagesJson);
            try {
              inputs.messages = messages;
            } finally {
              messages.delete();
            }
          } finally {
            messagesJson.delete();
          }
          const toolsJson = native.common_json.parse(JSON.stringify(request.tools ?? []));
          try {
            const tools = native.common_chat_tools_parse_oaicompat(toolsJson);
            try {
              inputs.tools = tools;
            } finally {
              tools.delete();
            }
          } finally {
            toolsJson.delete();
          }
          inputs.use_jinja = true;
          inputs.parallel_tool_calls = true;
          const effort = request.reasoningEffort;
          switch (effort) {
          case 'none':
            // This requests upstream's thinking toggle; templates may not support it.
            inputs.enable_thinking = false;
            break;
          case 'low': case 'medium': case 'high': {
            const kwargs = new native.string_map();
            try {
              kwargs.set('reasoning_effort', JSON.stringify(effort));
              inputs.chat_template_kwargs = kwargs;
            } finally {
              kwargs.delete();
            }
            break;
          }
          case undefined: break;
          default: {
            const exhaustive: never = effort;
            throw new Error(`Unknown reasoning effort: ${exhaustive}`);
          }
          }
          inputs.reasoning_format = native.common_reasoning_format.COMMON_REASONING_FORMAT_DEEPSEEK;
          params = renderThinkingTemplate({ offRequested: effort === 'none', render: () => templates.apply(inputs) });
        } finally {
          inputs.delete();
        }
        parser = new native.common_chat_parser_params(params);
        // The upstream constructor copies the format and generation prefix,
        // but not the parser arena. Both property accesses use owned copies.
        const arena = params.parser;
        try {
          parser.parser = arena;
        } finally {
          arena.delete();
        }
        const promptParts: ChatPromptPart[] = [];
        const nativePrompt = params.prompt;
        try {
          const parts = nativePrompt.parts;
          try {
            for (let index = 0; index < parts.size(); index++) {
              const part = parts.get(index);
              if (!part) {
                throw new Error('Missing native prompt part');
              }
              try {
                promptParts.push({ text: part.text, isInput: part.is_input });
              } finally {
                part.delete();
              }
            }
          } finally {
            parts.delete();
          }
        } finally {
          nativePrompt.delete();
        }
        const stops = params.additional_stops;
        let additionalStops: string[];
        try {
          additionalStops = Array.from(stops);
        } finally {
          stops.delete();
        }
        const parserParams = parser;
        const chatParams: ChatParams = params;
        return {
          params: chatParams,
          prompt: promptParts.map(part => part.text).join(''),
          promptParts,
          additionalStops,
          images,
          dispose,
          parse({ text, partial }: { text: string, partial: boolean }): Omit<GenerationResult, 'finishReason'> {
            assertIdle();
            if (parser === undefined) {
              throw new Error('Native chat request has been disposed');
            }
            const input = new native.common_chat_input(text);
            try {
              const message = native.common_chat_parse(input, partial, parserParams);
              try {
                const calls = message.tool_calls;
                try {
                  const toolCalls: GenerationResult['toolCalls'] = [];
                  for (let index = 0; index < calls.size(); index++) {
                    const call = calls.get(index);
                    if (!call) {
                      throw new Error('Missing native tool call');
                    }
                    try {
                      toolCalls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } });
                    } finally {
                      call.delete();
                    }
                  }
                  return { content: message.content, reasoningContent: message.reasoning_content, toolCalls };
                } finally {
                  calls.delete();
                }
              } finally {
                message.delete();
              }
            } finally {
              input.delete();
            }
          },
        };
      } catch (error) {
        logFailure({ stage: 'template', error });
        dispose();
        // Unsupported template inputs are recoverable; a Wasm trap is not.
        // Keep the original failure so the service retires the resident runtime
        // instead of reusing its cached template and native state.
        if (error instanceof WebAssembly.RuntimeError) {
          throw error;
        }
        throw new LlamaCppBrowserError({ code: isUnsupportedReasoningError({ error }) ? 'reasoning-unsupported' : 'template-unsupported' });
      }
    },
  };
}

export type NativeChat = ReturnType<typeof bindNativeChat>;
export const TEST_ONLY = {
};
