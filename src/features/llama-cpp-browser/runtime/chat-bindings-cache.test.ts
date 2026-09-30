import { describe, expect, it, vi } from 'vitest';
import { bindNativeChat } from './chat-bindings';

function disposableVector<T>(values: T[]) {
  return { ...values, [Symbol.iterator]: function* () {
    yield* values;
  }, delete: vi.fn() };
}

describe('native chat template lifetime', () => {
  it('reuses a template for one resident model and drops it before pointer reuse', () => {
    const deletedTemplates = vi.fn();
    const templateConstructed = vi.fn();
    class Inputs {
      messages: unknown; tools: unknown; use_jinja = false; parallel_tool_calls = false; enable_thinking = true;
      reasoning_format = 0; chat_template_kwargs: unknown; delete = vi.fn();
    }
    class Params {
      format = 0; prompt = ''; grammar = ''; grammar_lazy = false; generation_prompt = ''; supports_thinking = false;
      thinking_start_tag = ''; thinking_end_tags = disposableVector<string>([]); grammar_triggers = disposableVector<never>([]);
      preserved_tokens = disposableVector<string>([]); additional_stops = disposableVector<string>([]); parser = '';
      delete = vi.fn();
    }
    class Parser {
      reasoning_format = 0; parse_tool_calls = false; parser: unknown; delete = vi.fn();
      constructor(_params: Params) {}
    }
    class Arena {
      load(_text: string) {} delete() {}
    }
    class Templates {
      constructor(_model: bigint, _chatTemplate: string, _bos: string, _eos: string) {
        templateConstructed();
      }
      delete() {
        deletedTemplates();
      }
      apply(_inputs: Inputs) {
        return new Params();
      }
    }
    const fakeNative = {
      string_map: class {
        set(_key: string, _value: string) {} delete() {}
      },
      common_reasoning_format: { COMMON_REASONING_FORMAT_DEEPSEEK: 1 },
      common_json: { parse: (_text: string) => ({ delete() {} }) },
      common_chat_msgs_parse_oaicompat: (_json: unknown) => ({ delete() {} }),
      common_chat_tools_parse_oaicompat: (_json: unknown) => ({ delete() {} }),
      common_chat_templates_inputs: Inputs,
      common_chat_templates: Templates,
      common_chat_parser_params: Parser,
      common_peg_arena: Arena,
      common_chat_parse: () => {
        throw new Error('unused');
      },
    };
    const chat = bindNativeChat({ native: fakeNative as never });
    const assertIdle = vi.fn();
    const request = { messages: [], tools: undefined, reasoningEffort: undefined };

    chat.prepare({ assertIdle, model: 7n, request }).dispose();
    chat.prepare({ assertIdle, model: 7n, request }).dispose();
    expect(templateConstructed).toHaveBeenCalledTimes(1);
    expect(deletedTemplates).not.toHaveBeenCalled();

    chat.releaseModel({ assertIdle, model: 7n });
    expect(deletedTemplates).toHaveBeenCalledTimes(1);
    chat.releaseModel({ assertIdle, model: 7n });
    expect(deletedTemplates).toHaveBeenCalledTimes(1);

    chat.prepare({ assertIdle, model: 7n, request }).dispose();
    expect(templateConstructed).toHaveBeenCalledTimes(2);
    chat.releaseModel({ assertIdle, model: 7n });
    expect(deletedTemplates).toHaveBeenCalledTimes(2);
  });
});
