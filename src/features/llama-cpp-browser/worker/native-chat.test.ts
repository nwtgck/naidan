// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { prepareChat, createGrammarSampler, preservedTokenIds, tokenizeChatText } from './native-chat';
import { createChatSampler, copyReasoningEndMatch } from './chat-sampler';
import { createSyntheticGguf } from './test-utils/synthetic-gguf';
import type { GenerateInput, LlamaCppProfile } from '@/features/llama-cpp-browser/types';

// A small Jinja fixture whose tool syntax is discovered by upstream's parser builder.
const template = `\
{% if reasoning_effort is defined %}{{ 'Reasoning: ' + reasoning_effort + '\\n' }}{% endif %}
{% if tools %}{{ 'Tools: ' + (tools | tojson) + '\\n' }}{% endif %}
{% for message in messages %}
{{ '<|im_start|>' + message.role + '\\n' }}
{% if message.role == 'tool' %}{{ '<tool_response>\\n' + message.content + '\\n</tool_response>' }}
{% elif message.tool_calls %}{% for call in message.tool_calls %}{{ '<tool_call>\\n' }}{{ {'name': call.function.name, 'arguments': call.function.arguments} | tojson }}{{ '\\n</tool_call>' }}{% endfor %}
{% else %}{{ message.content }}{% endif %}
{{ '<|im_end|>\\n' }}
{% endfor %}
{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}`;
const tools: NonNullable<GenerateInput['tools']> = [{ type: 'function', function: { name: 'lookup', description: 'Look up a city', parameters: {
  type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
} } }];
// Emscripten requires Node 24 for memory64; CPU32 remains covered on older Node.
const profiles: LlamaCppProfile[] = ['cpu-wasm32'];
if (Number(process.versions.node.split('.')[0]) >= 24) profiles.push('cpu-wasm64');
// The JSPI artifact can exercise native chat/sampling on CPU without a GPU adapter.
if ('promising' in WebAssembly && 'Suspending' in WebAssembly) {
  profiles.push('webgpu-wasm32-jspi');
  if (Number(process.versions.node.split('.')[0]) >= 24) profiles.push('webgpu-wasm64-jspi');
}
describe.each(profiles)('native chat on %s', profile => {
  let core: Core; let model = 0n;
  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile, baseURL, moduleOptions: { wasmBinary: await readFile(new URL(`${profile}/browser/core.wasm`, baseURL)), print() {}, printErr() {} } });
    await core.api.llama_backend_init();
    core.module.FS.writeFile('/fixture.gguf', createSyntheticGguf({ chatTemplate: template }));
    const params = core.allocRecord({ name: 'llama_model_params' }); const filename = core.utf8({ text: '/fixture.gguf' });
    try {
      await core.api.llama_model_default_params(params);
      core.setField({ name: 'llama_model_params', pointer: params, field: 'n_gpu_layers', value: 0 });
      model = await core.api.llama_model_load_from_file(filename, params);
      expect(model).not.toBe(0n);
    } finally {
      core.free({ pointer: params }); core.free({ pointer: filename });
    }
  }, 30000);
  afterAll(async () => {
    if (model) await core.api.llama_model_free(model); if (core) await core.api.llama_backend_free();
  });
  describe('native Jinja and tool parser through the application runtime', () => {
    it('streams weather calls and ordinary content through native grammar and partial parsing', async () => {
      const weatherTools: NonNullable<GenerateInput['tools']> = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {
        type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
      } } }];
      const chat = prepareChat({ core, model, request: { messages: [{ role: 'user', content: 'Get Tokyo weather' }], tools: weatherTools, reasoningEffort: undefined } });
      try {
        const api = core.api; const vocab = await api.llama_model_get_vocab(model);
        const cp = core.allocRecord({ name: 'llama_context_params' });
        let context = 0n;
        try {
          await api.llama_context_default_params(cp);
          for (const [field, value] of Object.entries({ n_ctx: 256, n_batch: 128, n_ubatch: 128, n_threads: 1, n_threads_batch: 1 })) core.setField({ name: 'llama_context_params', pointer: cp, field, value });
          context = await api.llama_init_from_model(model, cp); expect(context).not.toBe(0n);
          const first = core.alloc({ bytes: 4 }); const batch = core.allocRecord({ name: 'llama_batch' });
          try {
            const span = core.bytes({ pointer: first, length: 4 }); new DataView(span.buffer, span.byteOffset, 4).setInt32(0, 1, true);
            await api.llama_batch_get_one(batch, first, 1); expect(await api.llama_decode(context, batch)).toBe(0);
          } finally {
            core.free({ pointer: batch }); core.free({ pointer: first });
          }
          for (const output of ['Hello.', `\
<tool_call>
{"name":"get_weather","arguments":{"city":"Tokyo"}}
</tool_call>`]) {
            const sp = core.allocRecord({ name: 'llama_sampler_chain_params' });
            let sampler: Awaited<ReturnType<typeof createChatSampler>> | undefined;
            try {
              await api.llama_sampler_chain_default_params(sp);
              const chain = await api.llama_sampler_chain_init(sp);
              await api.llama_sampler_chain_add(chain, await api.llama_sampler_init_greedy());
              sampler = await createChatSampler({ core, vocab, chain, params: chat.params });
              const count = await api.llama_vocab_n_tokens(vocab);
              for (const token of await tokenizeChatText({ core, vocab, text: output })) {
                const pointer = await api.llama_get_logits_ith(context, -1); const span = core.bytes({ pointer, length: count * 4 });
                const logits = new Float32Array(span.buffer, span.byteOffset, count); logits.fill(-1000); logits[token] = 1000;
                expect(await sampler.sample({ context })).toBe(token);
              }
            } finally {
              if (sampler) await sampler.dispose(); core.free({ pointer: sp });
            }

            let content = ''; let reasoning = '';
            for (let length = 1; length <= output.length; length++) {
              const parsed = chat.parse({ text: output.slice(0, length), partial: true });
              expect(parsed.content.startsWith(content), `content prefix at ${length}`).toBe(true);
              expect(parsed.reasoningContent.startsWith(reasoning), `reasoning prefix at ${length}`).toBe(true);
              content = parsed.content; reasoning = parsed.reasoningContent;
            }
            const result = chat.parse({ text: output, partial: false });
            expect(result.content.startsWith(content)).toBe(true);
            if (output === 'Hello.') expect(result.content).toBe(output);
            else {
              expect(result.toolCalls).toHaveLength(1);
              expect(result.toolCalls[0]?.function.name).toBe('get_weather');
              expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ city: 'Tokyo' });
            }
          }
        } finally {
          if (context) await api.llama_free(context); core.free({ pointer: cp });
        }
      } finally {
        chat.dispose();
      }
    });

    it('renders tool definitions, parses partial/final tool output and renders the result in the next turn', async () => {
      const messages: GenerateInput['messages'] = [{ role: 'user', content: 'Find Tokyo' }];
      const chat = prepareChat({ core, model, request: { messages, tools, reasoningEffort: 'none' } });
      try {
        expect(chat.params.prompt).toContain('lookup'); expect(chat.params.prompt).toContain('Find Tokyo');
        const output = `\
<tool_call>
{"name":"lookup","arguments":{"city":"Tokyo"}}
</tool_call>`;
        const partial = chat.parse({ text: output.slice(0, 35), partial: true });
        expect(partial.content).not.toContain('<tool_call>');
        const result = chat.parse({ text: output, partial: false });
        expect(result.content).toBe('');
        expect(result.toolCalls).toHaveLength(1);
        expect(chat.parse({ text: output + output, partial: false }).toolCalls).toHaveLength(2);
        expect(result.toolCalls[0]?.function.name).toBe('lookup');
        expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ city: 'Tokyo' });
        const next = prepareChat({ core, model, request: { messages: [...messages,
          { role: 'assistant', content: result.content, tool_calls: result.toolCalls.map(call => ({ ...call, id: 'call-1' })) },
          { role: 'tool', content: 'Sunny', tool_call_id: 'call-1', name: 'lookup' },
        ], tools, reasoningEffort: 'none' } });
        try {
          expect(next.params.prompt).toContain(`\
<tool_response>
Sunny`);
        } finally {
          next.dispose();
        }
        const vocab = await core.api.llama_model_get_vocab(model);
        const preservedTokens = await preservedTokenIds({ core, vocab, params: chat.params });
        const grammar = await createGrammarSampler({ core, vocab, params: chat.params, preservedTokens });
        if (chat.params.grammar) expect(grammar).not.toBe(0n);
        if (grammar) await core.api.llama_sampler_free(grammar);
      } finally {
        chat.dispose();
      }
    });
    it.each(['low', 'medium', 'high'] as const)('passes %s reasoning effort as a native template kwarg', effort => {
      const chat = prepareChat({ core, model, request: { messages: [{ role: 'user', content: 'Hello' }], tools: undefined, reasoningEffort: effort } });
      try {
        expect(chat.params.prompt).toContain(`Reasoning: ${effort}`);
      } finally {
        chat.dispose();
      }
    });
    it('leaves unspecified effort to the template and does not invent a none effort string', () => {
      for (const effort of [undefined, 'none'] as const) {
        const chat = prepareChat({ core, model, request: { messages: [{ role: 'user', content: 'Hello' }], tools: undefined, reasoningEffort: effort } });
        try {
          expect(chat.params.prompt).not.toContain('Reasoning:');
        } finally {
          chat.dispose();
        }
      }
    });
    it('repeatedly releases native message/vector/parser handles without invalidating the model', () => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const chat = prepareChat({ core, model, request: { messages: [{ role: 'user', content: 'Hello' }], tools: undefined, reasoningEffort: 'none' } });
        try {
          expect(chat.parse({ text: 'Hello back', partial: false }).content).toBe('Hello back');
        } finally {
          chat.dispose();
        }
      }
    });
  });

  it('owns the native reasoning end copy across reset and release after a counting-to-done transition', async () => {
    const native = core.module; const api = core.api;
    const starts = new native.llama_token_sequences(); const ends = new native.llama_token_sequences();
    const start = new native.llama_tokens(); const end = new native.llama_tokens(); const forced = new native.llama_tokens();
    let budget = 0n;
    try {
      start.push_back(4); end.push_back(5); starts.push_back(start); ends.push_back(end);
      budget = native.common_reasoning_budget_init(await api.llama_model_get_vocab(model), starts, ends, forced, 2147483647, native.common_reasoning_budget_state.REASONING_BUDGET_IDLE);
      await api.llama_sampler_accept(budget, 4);
      expect(native.common_reasoning_budget_get_state(budget).value).toBe(1);
      await api.llama_sampler_accept(budget, 5);
      expect(native.common_reasoning_budget_get_state(budget).value).toBe(4);
      const match = copyReasoningEndMatch({ core, budget });
      try {
        expect(match.size()).toBe(1); expect(match.get(0)).toBe(5); expect(Array.from(match)).toEqual([5]);
        match.set(0, 6);
        const unchanged = copyReasoningEndMatch({ core, budget });
        try {
          expect(Array.from(unchanged)).toEqual([5]);
        } finally {
          unchanged.delete();
        }
        await api.llama_sampler_reset(budget);
        const empty = copyReasoningEndMatch({ core, budget });
        try {
          expect(empty.size()).toBe(0);
        } finally {
          empty.delete();
        }
        expect(match.get(0)).toBe(6);
        await api.llama_sampler_free(budget); budget = 0n;
        expect(match.get(0)).toBe(6);
      } finally {
        match.delete();
      }
    } finally {
      if (budget) await api.llama_sampler_free(budget);
      forced.delete(); end.delete(); start.delete(); ends.delete(); starts.delete();
    }
  });

  it('keeps tool markers inside thinking unconstrained, then restores native grammar after thinking ends', async () => {
    const { createChatSampler } = await import('./chat-sampler');
    const native = core.module; const api = core.api; const vocab = await api.llama_model_get_vocab(model);
    const stateSpy = vi.spyOn(native, 'common_reasoning_budget_get_state');
    const allocations: bigint[] = []; let context = 0n; let base = 0n;
    let sampler: Awaited<ReturnType<typeof createChatSampler>> | undefined;
    const params = new native.common_chat_params();
    const alloc = ({ size }: { size: number }): bigint => {
      const pointer = core.alloc({ bytes: size }); allocations.push(pointer); return pointer;
    };
    const record = ({ name }: { name: string }): bigint => {
      const pointer = core.allocRecord({ name }); allocations.push(pointer); return pointer;
    };
    const tokensFor = async ({ text }: { text: string }): Promise<number[]> => {
      const pointer = core.utf8({ text }); allocations.push(pointer);
      const count = Math.abs(await api.llama_tokenize(vocab, pointer, new TextEncoder().encode(text).length, 0n, 0, 0, 1));
      const target = alloc({ size: count * 4 });
      expect(await api.llama_tokenize(vocab, pointer, new TextEncoder().encode(text).length, target, count, 0, 1)).toBe(count);
      const bytes = core.bytes({ pointer: target, length: count * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true));
    };
    try {
      params.grammar = 'root ::= "<tool_call>" "{\\"ok\\":true}" "</tool_call>"';
      params.grammar_lazy = true; params.generation_prompt = '<think>'; params.thinking_start_tag = '<think>';
      const ends = new native.string_vector(); const triggers = new native.common_grammar_triggers(); const trigger = new native.common_grammar_trigger();
      try {
        ends.push_back('</think>'); params.thinking_end_tags = ends;
        trigger.type = native.common_grammar_trigger_type.COMMON_GRAMMAR_TRIGGER_TYPE_WORD; trigger.value = '<tool_call>';
        triggers.push_back(trigger); params.grammar_triggers = triggers;
      } finally {
        trigger.delete(); triggers.delete(); ends.delete();
      }
      const cp = record({ name: 'llama_context_params' }); await api.llama_context_default_params(cp);
      for (const [field, value] of Object.entries({ n_ctx: 256, n_batch: 128, n_ubatch: 128, n_threads: 1, n_threads_batch: 1 })) core.setField({ name: 'llama_context_params', pointer: cp, field, value });
      context = await api.llama_init_from_model(model, cp); expect(context).not.toBe(0n);
      const first = alloc({ size: 4 }); new DataView(core.bytes({ pointer: first, length: 4 }).buffer, Number(first), 4).setInt32(0, 1, true);
      const batch = record({ name: 'llama_batch' }); await api.llama_batch_get_one(batch, first, 1); expect(await api.llama_decode(context, batch)).toBe(0);
      const sp = record({ name: 'llama_sampler_chain_params' }); await api.llama_sampler_chain_default_params(sp); base = await api.llama_sampler_chain_init(sp);
      await api.llama_sampler_chain_add(base, await api.llama_sampler_init_greedy());
      const owned = base; base = 0n; sampler = await createChatSampler({ core, vocab, chain: owned, params });
      const count = await api.llama_vocab_n_tokens(vocab);
      const sampleDesired = async ({ token }: { token: number }): Promise<number> => {
        const pointer = await api.llama_get_logits_ith(context, -1);
        const bytes = core.bytes({ pointer, length: count * 4 }); const logits = new Float32Array(bytes.buffer, bytes.byteOffset, count);
        logits.fill(-1000); logits[token] = 1000;
        return sampler!.sample({ context });
      };
      for (const token of await tokensFor({ text: 'Considering <tool_call>not JSON</tool_call> before deciding.</think><tool_call>' })) {
        expect(await sampleDesired({ token })).toBe(token);
      }
      const invalidTokens = await tokensFor({ text: 'X' }); const openingTokens = await tokensFor({ text: '{' });
      expect(invalidTokens).toHaveLength(1); expect(openingTokens).toHaveLength(1);
      const invalid = invalidTokens[0]!; const opening = openingTokens[0]!;
      expect(invalid).not.toBe(opening);
      expect(await sampleDesired({ token: invalid })).toBe(opening);
      for (const token of await tokensFor({ text: '"ok":true}</tool_call>' })) expect(await sampleDesired({ token })).toBe(token);
      const states = stateSpy.mock.results.flatMap(result => result.type === 'return' ? [result.value.value] : []);
      expect(states).toContain(1); expect(states).toContain(4);
    } finally {
      stateSpy.mockRestore();
      if (sampler) await sampler.dispose();
      if (base) await api.llama_sampler_free(base);
      if (context) await api.llama_free(context);
      params.delete(); for (const pointer of allocations.reverse()) core.free({ pointer });
    }
  }, 30000);


  it('preserves only native single-token markers for special-token rendering', async () => {
    const params = new core.module.common_chat_params(); const markers = new core.module.string_vector();
    const piece = core.alloc({ bytes: 32 });
    try {
      markers.push_back('<s>'); markers.push_back('multiple ordinary tokens'); params.preserved_tokens = markers;
      const vocab = await core.api.llama_model_get_vocab(model);
      const preserved = await preservedTokenIds({ core, vocab, params });
      expect(preserved).toEqual(new Set([1]));
      expect(await core.api.llama_token_to_piece(vocab, 1, piece, 32, 0, 0)).toBe(0);
      const length = await core.api.llama_token_to_piece(vocab, 1, piece, 32, 0, preserved.has(1) ? 1 : 0);
      expect(new TextDecoder().decode(core.bytes({ pointer: piece, length }))).toBe('<s>');
    } finally {
      core.free({ pointer: piece }); markers.delete(); params.delete();
    }
  });

});
