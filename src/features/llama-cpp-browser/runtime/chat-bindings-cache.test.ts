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
    messages: unknown; tools: unknown; add_generation_prompt = true; use_jinja = false; parallel_tool_calls = false; enable_thinking = true;
    reasoning_format = 0; chat_template_kwargs: unknown; delete = vi.fn();
  }
  const deleteParams = vi.fn();
  const deleteParser = vi.fn();
  const arena = { delete: vi.fn() };
  const assignArena = vi.fn();
  const promptParts = [
    { text: '<s>', is_input: false, delete: vi.fn() },
    { text: 'user 日本語\0😀', is_input: true, delete: vi.fn() },
  ];
  const nativeParts = { size: () => promptParts.length, get: vi.fn((index: number) => promptParts[index]), delete: vi.fn() };
  const nativePrompt = { parts: nativeParts, delete: vi.fn() };
  const inputConstructed = vi.fn();
  const deleteInput = vi.fn();
  const calls = { size: () => 0, get: vi.fn(), delete: vi.fn() };
  const message = { content: 'reply', reasoning_content: 'reason', tool_calls: calls, delete: vi.fn() };
  const parse = vi.fn((_input: unknown, _partial: boolean, _parser: unknown) => message);
  class Params {
    format = 0; prompt = nativePrompt; grammar = ''; grammar_lazy = false; generation_prompt = ''; supports_thinking = false;
    thinking_start_tag = ''; thinking_end_tags = disposableVector<string>([]); grammar_triggers = disposableVector<never>([]);
    preserved_tokens = disposableVector<string>([]); additional_stops = disposableVector<string>([]); parser = arena;
    delete = deleteParams;
  }
  class Parser {
    get parser() {
      return arena;
    }

    set parser(value: typeof arena) {
      assignArena(value);
    }

    delete = deleteParser;

    constructor(_params: Params) {}
  }
  class Input {
    constructor(readonly text: string) {
      inputConstructed(text);
    }

    delete = deleteInput;
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
      set(_key: string, _value: string) {}

      delete() {}
    },
    common_reasoning_format: { COMMON_REASONING_FORMAT_DEEPSEEK: 1 },
    common_json: { parse: (_text: string) => ({ delete() {} }) },
    common_chat_msgs_parse_oaicompat: (_json: unknown) => ({ delete() {} }),
    common_chat_tools_parse_oaicompat: (_json: unknown) => ({ delete() {} }),
    common_chat_templates_inputs: Inputs,
    common_chat_templates: Templates,
    common_chat_parser_params: Parser,
    common_chat_input: Input,
    common_chat_parse: parse,
  };
  const chat = bindNativeChat({ native: fakeNative as never });
  const assertIdle = vi.fn();
  const request = { messages: [], tools: undefined, reasoningEffort: undefined };

  return {
    chat,
    assertIdle,
    request,
    templateConstructed,
    deletedTemplates,
    apply,
    deleteParser,
    deleteParams,
    arena,
    assignArena,
    promptParts,
    nativeParts,
    nativePrompt,
    inputConstructed,
    deleteInput,
    parse,
    message,
    calls,
    [Symbol.dispose]() {
      chat.releaseModel({ assertIdle, model: 7n });
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('native chat template lifetime', () => {
  it('explicit live generation boundaries do not change ordinary chat defaults', () => {
    using f = fixture();
    f.chat.prepareWithGenerationPrompt({ assertIdle: f.assertIdle, model: 7n, request: f.request, generationPrompt: 'omit' }).dispose();
    expect(f.apply.mock.calls[0]?.[0].add_generation_prompt).toBe(false);
    f.chat.prepareWithGenerationPrompt({ assertIdle: f.assertIdle, model: 7n, request: f.request, generationPrompt: 'include' }).dispose();
    expect(f.apply.mock.calls[1]?.[0].add_generation_prompt).toBe(true);
    f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request }).dispose();
    expect(f.apply.mock.calls[2]?.[0].add_generation_prompt).toBe(true);
    expect(f.templateConstructed).toHaveBeenCalledOnce();
  });

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
        if (error instanceof WebAssembly.RuntimeError) {
          expect(caught).toBe(error);
        }
      }
      f.chat.releaseModel({ assertIdle: f.assertIdle, model: 7n });
    }
  });
});

describe('v0.7 native chat value ownership', () => {
  it('copies the arena and prompt segments without retaining owned getter handles', () => {
    using f = fixture();
    const chat = f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    using _request = {
      [Symbol.dispose]() {
        chat.dispose();
      },
    };
    expect(f.assignArena).toHaveBeenCalledExactlyOnceWith(f.arena);
    expect(f.arena.delete).toHaveBeenCalledOnce();
    expect(f.nativePrompt.delete).toHaveBeenCalledOnce();
    expect(f.nativeParts.delete).toHaveBeenCalledOnce();
    for (const part of f.promptParts) {
      expect(part.delete).toHaveBeenCalledOnce();
    }
    expect(chat.promptParts).toEqual([{ text: '<s>', isInput: false }, { text: 'user 日本語\0😀', isInput: true }]);
    f.promptParts[1]!.text = 'overwritten';
    chat.dispose();
    expect(chat.prompt).toBe('<s>user 日本語\0😀');
    expect(chat.promptParts[1]!.text).toBe('user 日本語\0😀');
    expect(f.deleteParser).toHaveBeenCalledOnce();
    expect(f.deleteParams).toHaveBeenCalledOnce();
  });

  it('releases the arena and both request handles when copying the arena traps', () => {
    using f = fixture();
    const trap = new WebAssembly.RuntimeError('arena assignment');
    f.assignArena.mockImplementationOnce(() => {
      throw trap;
    });
    expect(() => f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request })).toThrow(trap);
    expect(f.arena.delete).toHaveBeenCalledOnce();
    expect(f.deleteParser).toHaveBeenCalledOnce();
    expect(f.deleteParams).toHaveBeenCalledOnce();
    expect(f.nativePrompt.delete).not.toHaveBeenCalled();
  });

  it.each(['missing', 'trap'] as const)('releases the prompt vector, value and request after a %s segment', failure => {
    using f = fixture();
    f.nativeParts.get.mockImplementationOnce(index => f.promptParts[index]).mockImplementationOnce(() => {
      if (failure === 'trap') {
        throw new WebAssembly.RuntimeError('part getter');
      }
      return undefined;
    });
    expect(() => f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request })).toThrow();
    expect(f.promptParts[0]!.delete).toHaveBeenCalledOnce();
    expect(f.promptParts[1]!.delete).not.toHaveBeenCalled();
    expect(f.nativeParts.delete).toHaveBeenCalledOnce();
    expect(f.nativePrompt.delete).toHaveBeenCalledOnce();
    expect(f.deleteParser).toHaveBeenCalledOnce();
    expect(f.deleteParams).toHaveBeenCalledOnce();
  });

  it('passes owned UTF-8-capable inputs to partial and final native parsing', () => {
    using f = fixture();
    const chat = f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    using _request = {
      [Symbol.dispose]() {
        chat.dispose();
      },
    };
    for (const partial of [true, false]) {
      expect(chat.parse({ text: '日本語\0😀', partial })).toEqual({ content: 'reply', reasoningContent: 'reason', toolCalls: [] });
      expect(f.parse).toHaveBeenLastCalledWith(expect.objectContaining({ text: '日本語\0😀' }), partial, expect.anything());
    }
    expect(f.deleteInput).toHaveBeenCalledTimes(2);
    expect(f.message.delete).toHaveBeenCalledTimes(2);
    expect(f.calls.delete).toHaveBeenCalledTimes(2);
    chat.dispose();
    expect(() => chat.parse({ text: '', partial: false })).toThrow('disposed');
    expect(f.inputConstructed).toHaveBeenCalledTimes(2);
  });

  it('frees an input when native parsing traps without inventing a message handle', () => {
    using f = fixture();
    const chat = f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    using _request = {
      [Symbol.dispose]() {
        chat.dispose();
      },
    };
    const trap = new WebAssembly.RuntimeError('native parser');
    f.parse.mockImplementationOnce(() => {
      throw trap;
    });
    expect(() => chat.parse({ text: 'input', partial: true })).toThrow(trap);
    expect(f.deleteInput).toHaveBeenCalledOnce();
    expect(f.message.delete).not.toHaveBeenCalled();
  });

  it('frees the input even when message cleanup throws', () => {
    using f = fixture();
    const chat = f.chat.prepare({ assertIdle: f.assertIdle, model: 7n, request: f.request });
    using _request = {
      [Symbol.dispose]() {
        chat.dispose();
      },
    };
    f.message.delete.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('message cleanup');
    });
    expect(() => chat.parse({ text: 'input', partial: false })).toThrow('message cleanup');
    expect(f.calls.delete).toHaveBeenCalledOnce();
    expect(f.message.delete).toHaveBeenCalledOnce();
    expect(f.deleteInput).toHaveBeenCalledOnce();
  });
});
