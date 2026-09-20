import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import type { common_chat_params, common_chat_parser_params, common_chat_templates } from 'llama-cpp-browser-core/profiles/cpu-wasm64/core.mjs';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError, type GenerateInput, type GenerationResult } from '@/features/llama-cpp-browser/types';

/** Native objects returned through Embind are owned copies, including properties. */
export function prepareChat({ core, model, request }: { core: Core, model: bigint, request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'> }) {
  core.assertIdle();
  const native = core.module;
  let templates: common_chat_templates | undefined;
  let params: common_chat_params | undefined;
  let parser: common_chat_parser_params | undefined;
  const dispose = (): void => {
    parser?.delete(); params?.delete(); templates?.delete();
  };
  try {
    templates = new native.common_chat_templates(model, '', '', '');
    const inputs = new native.common_chat_templates_inputs();
    try {
      const messagesJson = native.common_json.parse(JSON.stringify(request.messages));
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
    return { params, additionalStops, dispose,
      parse({ text, partial }: { text: string, partial: boolean }): Omit<GenerationResult, 'finishReason'> {
        core.assertIdle();
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

/** Translate native grammar triggers to the low-level sampler ABI. */
export async function createGrammarSampler({ core, vocab, params, preservedTokens }: { core: Core, vocab: bigint, params: common_chat_params, preservedTokens: ReadonlySet<number> }): Promise<bigint> {
  if (!params.grammar) return 0n;
  const allocations: bigint[] = [];
  const alloc = ({ bytes }: { bytes: number }): bigint => {
    const pointer = core.alloc({ bytes }); allocations.push(pointer); return pointer;
  };
  const string = ({ text }: { text: string }): bigint => {
    const pointer = core.utf8({ text }); allocations.push(pointer); return pointer;
  };
  try {
    const grammar = string({ text: params.grammar }); const root = string({ text: 'root' });
    if (!params.grammar_lazy) return await core.api.llama_sampler_init_grammar(vocab, grammar, root);
    const patterns: string[] = []; const tokens: number[] = [];
    const triggers = params.grammar_triggers;
    try {
      for (let index = 0; index < triggers.size(); index++) {
        const trigger = triggers.get(index);
        if (!trigger) throw new Error('Missing native grammar trigger');
        try {
          const type = trigger.type.value;
          switch (type) {
          case 0: tokens.push(trigger.token); break;
          case 1: {
            const ids = await tokenizeChatText({ core, vocab, text: trigger.value });
            if (ids.length === 1) {
              if (!preservedTokens.has(ids[0]!)) throw new Error('Atomic grammar triggers must be preserved');
              tokens.push(ids[0]!);
            } else patterns.push(trigger.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            break;
          }
          case 2: patterns.push(trigger.value); break;
          case 3: patterns.push((trigger.value.startsWith('^') ? '' : '^') + trigger.value + (trigger.value.endsWith('$') ? '' : '$')); break;
          default: { const exhaustive: never = type; throw new Error(`Unknown native grammar trigger: ${exhaustive}`); }
          }
        } finally {
          trigger.delete();
        }
      }
    } finally {
      triggers.delete();
    }
    const patternPointers = patterns.map(text => string({ text }));
    const patternArray = patterns.length ? alloc({ bytes: patterns.length * core.pointerBytes }) : 0n;
    for (const [index, pointer] of patternPointers.entries()) {
      const bytes = core.bytes({ pointer: patternArray + BigInt(index * core.pointerBytes), length: core.pointerBytes });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (core.pointerBytes === 8) view.setBigUint64(0, pointer, true); else view.setUint32(0, Number(pointer), true);
    }
    const tokenArray = tokens.length ? alloc({ bytes: tokens.length * 4 }) : 0n;
    for (const [index, token] of tokens.entries()) {
      const bytes = core.bytes({ pointer: tokenArray + BigInt(index * 4), length: 4 });
      new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, token, true);
    }
    return await core.api.llama_sampler_init_grammar_lazy_patterns(vocab, grammar, root, patternArray, BigInt(patterns.length), tokenArray, BigInt(tokens.length));
  } finally {
    for (const pointer of allocations.reverse()) core.free({ pointer });
  }
}
export async function tokenizeChatText({ core, vocab, text }: { core: Core, vocab: bigint, text: string }): Promise<number[]> {
  const api = core.api;
  if (!text) return [];
  const pointer = core.utf8({ text }); let tokens = 0n;
  try {
    const length = new TextEncoder().encode(text).length;
    const count = Math.abs(await api.llama_tokenize(vocab, pointer, length, 0n, 0, 0, 1));
    if (!count) return [];
    tokens = core.alloc({ bytes: count * 4 });
    if (await api.llama_tokenize(vocab, pointer, length, tokens, count, 0, 1) !== count) throw new Error('Native prefix tokenization failed');
    const bytes = core.bytes({ pointer: tokens, length: count * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true));
  } finally {
    if (tokens) core.free({ pointer: tokens }); core.free({ pointer });
  }
}

export async function preservedTokenIds({ core, vocab, params }: { core: Core, vocab: bigint, params: common_chat_params }): Promise<Set<number>> {
  const nativeTokens = params.preserved_tokens;
  let texts: string[];
  try {
    texts = Array.from(nativeTokens);
  } finally {
    nativeTokens.delete();
  }
  const preserved = new Set<number>();
  for (const text of texts) {
    const ids = await tokenizeChatText({ core, vocab, text });
    if (ids.length === 1) preserved.add(ids[0]!);
  }
  return preserved;
}
export const TEST_ONLY = {
};
