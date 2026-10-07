import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCode } from '@/features/llama-cpp-browser/types';
import { bindNativeChat } from './chat-bindings';

function disposableVector<T>(values: T[]) {
  return {
    ...values,
    [Symbol.iterator]: function* () {
      yield* values;
    },
    delete: vi.fn(),
  };
}

function fixture() {
  const deletedTemplates = vi.fn();
  const templateConstructed = vi.fn();
  class Inputs {
    messages: unknown; tools: unknown; use_jinja = false; parallel_tool_calls = false; enable_thinking = true;
    reasoning_format = 0; chat_template_kwargs: unknown; delete = vi.fn();
  }
  const deleteParams = vi.fn();
  const deleteParser = vi.fn();
  class Params {
    format = 0; prompt = ''; grammar = ''; grammar_lazy = false; generation_prompt = ''; supports_thinking = false;
    thinking_start_tag = ''; thinking_end_tags = disposableVector<string>([]); grammar_triggers = disposableVector<never>([]);
    preserved_tokens = disposableVector<string>([]); additional_stops = disposableVector<string>([]); parser = '';
    delete = deleteParams;
  }
  class Parser {
    reasoning_format = 0; parse_tool_calls = false; parser: unknown; delete = deleteParser;
    constructor(_params: Params) {}
  }
  class Arena {
    load(_text: string) {} delete() {}
  }
  const apply = vi.fn((_inputs: Inputs) => new Params());
  class Templates {
    constructor(_model: bigint, _chatTemplate: string, _bos: string, _eos: string) {
      templateConstructed();
    }
    delete() {
      deletedTemplates();
    }
    apply = apply;
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

  return { chat, assertIdle, request, templateConstructed, deletedTemplates, apply, deleteParser, deleteParams };
}

afterEach(() => vi.restoreAllMocks());

describe('native chat template lifetime', () => {
  it('reuses a template for one resident model and drops it before pointer reuse', () => {
    const { chat, assertIdle, request, templateConstructed, deletedTemplates } = fixture();
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

describe('cached template failure ownership', () => {
  it('preserves a native trap rather than declaring the resident runtime reusable', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fixture();
    f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request }).dispose();
    const trap = new WebAssembly.RuntimeError('controlled native trap');
    f.apply.mockImplementationOnce(() => {
      throw trap;
    });
    let failure: unknown;
    try {
      f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(trap);
    expect(errorCode({ error: failure })).toBe('runtime-error');
    f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
    expect(f.deletedTemplates).toHaveBeenCalledOnce();
  });

  it('retains expected template errors and its healthy cached template', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fixture();
    f.apply.mockImplementationOnce(() => {
      throw new Error('unsupported message role');
    });
    expect(() => f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request })).toThrow('template-unsupported');
    f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request }).dispose();
    expect(f.templateConstructed).toHaveBeenCalledOnce();
    f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
  });

  it('releases both request handles once even when the parser destructor throws', () => {
    const f = fixture();
    const prepared = f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    const trap = new WebAssembly.RuntimeError('controlled destructor trap');
    f.deleteParser.mockImplementationOnce(() => {
      throw trap;
    });
    expect(() => prepared.dispose()).toThrow(trap);
    expect(f.deleteParams).toHaveBeenCalledOnce();
    prepared.dispose();
    expect(f.deleteParser).toHaveBeenCalledOnce();
    expect(f.deleteParams).toHaveBeenCalledOnce();
    f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
  });
});

describe('native thinking preference rejection', () => {
  it('distinguishes rejected off from generic template failure without retiring the template', () => {
    const f = fixture();
    f.apply.mockImplementationOnce(() => {
      throw new Error('enable_thinking must be true');
    });
    expect(() => f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: { ...f.request, reasoningEffort: 'none' } }))
      .toThrow('reasoning-unsupported');
    f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request }).dispose();
    expect(f.templateConstructed).toHaveBeenCalledTimes(1);
    f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
  });

  it('does not turn an unrelated template failure or a trap into a reasoning retry', () => {
    for (const error of [new Error('Unsupported system role'), new WebAssembly.RuntimeError('enable_thinking is not supported')]) {
      const f = fixture();
      f.apply.mockImplementationOnce(() => {
        throw error;
      });
      try {
        f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: { ...f.request, reasoningEffort: 'none' } });
        throw new Error('Expected template failure');
      } catch (caught) {
        expect(errorCode({ error: caught })).not.toBe('reasoning-unsupported');
        if (error instanceof WebAssembly.RuntimeError) expect(caught).toBe(error);
      }
      f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
    }
  });
});
