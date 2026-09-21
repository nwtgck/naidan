import type { MainModule, common_chat_params, common_chat_parser_params, common_chat_templates_inputs, common_chat_msg } from 'llama-cpp-browser-core/profiles/cpu-wasm64/core.mjs';
import { LlamaCppBrowserError, type GenerateInput, type GenerationResult } from '@/features/llama-cpp-browser/types';
import { logFailure } from '@/features/llama-cpp-browser/debug-log';

// Only the chat result fields used by Naidan cross the profile boundary. In
// particular, size_t-backed JSON, arena and delimiter helpers remain native.
export type ChatParams = Pick<common_chat_params,
  'delete' | 'format' | 'prompt' | 'grammar' | 'grammar_lazy' | 'generation_prompt'
  | 'supports_thinking' | 'thinking_start_tag' | 'thinking_end_tags'
  | 'grammar_triggers' | 'preserved_tokens' | 'additional_stops' | 'parser'>;
type ChatInputValues = Pick<common_chat_templates_inputs,
  'delete' | 'tools' | 'use_jinja' | 'parallel_tool_calls' | 'enable_thinking' | 'reasoning_format' | 'chat_template_kwargs'>;
type ParserValues = Pick<common_chat_parser_params, 'delete' | 'reasoning_format' | 'parse_tool_calls'>;
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
  Params extends ChatParams,
  Arena extends { delete(): void; load(text: string): void },
  Parser extends ParserValues & { parser: Arena },
>({ native }: { native: Pick<MainModule, 'string_map' | 'common_reasoning_format'> & {
  common_json: { parse(text: string): Json };
  common_chat_msgs_parse_oaicompat(json: Json): Messages;
  common_chat_tools_parse_oaicompat(json: Json): ChatInputValues['tools'];
  common_chat_templates_inputs: new () => Inputs;
  common_chat_templates: new (model: bigint, chatTemplate: string, bosToken: string, eosToken: string) => { delete(): void; apply(inputs: Inputs): Params };
  common_chat_parser_params: new (params: Params) => Parser;
  common_peg_arena: new () => Arena;
  common_chat_parse(text: string, partial: boolean, parser: Parser): ParsedMessage;
} }) {
  /* eslint-enable local-rules-named-args/require-named-args */
  return {
    prepare({ assertIdle, model, request }: { assertIdle: () => void, model: bigint, request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'> }) {
      assertIdle();
      let templates: InstanceType<typeof native.common_chat_templates> | undefined;
      let params: Params | undefined;
      let parser: Parser | undefined;
      const dispose = (): void => {
        parser?.delete(); params?.delete(); templates?.delete();
      };
      try {
        templates = new native.common_chat_templates(model, '', '', '');
        const images: { marker: string, blob: Blob }[] = [];
        const messages = request.messages.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.map(part => {
          switch (part.type) {
          case 'text': return part;
          case 'image': {
            // An unpredictable marker keeps literal user text distinct from media.
            const marker = `<__image_${crypto.randomUUID()}__>`;
            images.push({ marker, blob: part.blob });
            return { type: 'media_marker', text: marker };
          }
          default: { const exhaustive: never = part; throw new Error(`Unknown part: ${exhaustive}`); }
          }
        }) }));
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
              kwargs.set('reasoning_effort', JSON.stringify(effort)); inputs.chat_template_kwargs = kwargs;
            } finally {
              kwargs.delete();
            }
            break;
          }
          case undefined: break;
          default: { const exhaustive: never = effort; throw new Error(`Unknown reasoning effort: ${exhaustive}`); }
          }
          inputs.reasoning_format = native.common_reasoning_format.COMMON_REASONING_FORMAT_DEEPSEEK;
          params = templates.apply(inputs);
        } finally {
          inputs.delete();
        }
        parser = new native.common_chat_parser_params(params);
        parser.reasoning_format = native.common_reasoning_format.COMMON_REASONING_FORMAT_DEEPSEEK;
        parser.parse_tool_calls = !!request.tools?.length;
        const arena = new native.common_peg_arena();
        try {
          if (params.parser) arena.load(params.parser);
          parser.parser = arena;
        } finally {
          arena.delete();
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
        return { params: chatParams, additionalStops, images, dispose,
          parse({ text, partial }: { text: string, partial: boolean }): Omit<GenerationResult, 'finishReason'> {
            assertIdle();
            const message = native.common_chat_parse(text, partial, parserParams);
            try {
              const calls = message.tool_calls;
              try {
                const toolCalls: GenerationResult['toolCalls'] = [];
                for (let index = 0; index < calls.size(); index++) {
                  const call = calls.get(index);
                  if (!call) throw new Error('Missing native tool call');
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
          },
        };
      } catch (error) {
        logFailure({ stage: 'template', error });
        dispose(); throw new LlamaCppBrowserError({ code: 'template-unsupported' });
      }
    }
  };
}
export type NativeChat = ReturnType<typeof bindNativeChat>;
export const TEST_ONLY = {
};
