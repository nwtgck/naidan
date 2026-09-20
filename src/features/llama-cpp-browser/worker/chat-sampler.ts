import { logDiagnostic, logFailure, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { common_chat_params } from 'llama-cpp-browser-core/profiles/cpu-wasm64/core.mjs';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { createGrammarSampler, preservedTokenIds, tokenizeChatText } from './native-chat';

/** Own the sampling chain and native grammar/reasoning state for one generation. */
export async function createChatSampler({ core, vocab, chain, params }: { core: Core, vocab: bigint, chain: bigint, params: common_chat_params }) {
  const api = core.api; const native = core.module;
  let grammar = 0n; let budget = 0n; let outer = 0n;
  let grammarAttached = false; let chainAttached = false;
  const dispose = async (): Promise<void> => {
    try {
      if (outer) await api.llama_sampler_free(outer);
    } finally {
      try {
        if (!chainAttached) await api.llama_sampler_free(chain);
      } finally {
        try {
          if (grammar && !grammarAttached) await api.llama_sampler_free(grammar);
        } finally {
          if (budget) await api.llama_sampler_free(budget);
        }
      }
    }
  };
  try {
    const preservedTokens = await preservedTokenIds({ core, vocab, params });
    grammar = await createGrammarSampler({ core, vocab, params, preservedTokens });
    if (params.grammar && !grammar) throw new Error('Native grammar initialization failed');
    const prefix = await tokenizeChatText({ core, vocab, text: params.generation_prompt });
    // Match upstream common sampling: ignore a tokenizer-added leading space.
    if (prefix.length && params.generation_prompt && !/^\s/.test(params.generation_prompt)) {
      const piece = core.alloc({ bytes: 16 });
      try {
        const length = await api.llama_token_to_piece(vocab, prefix[0]!, piece, 16, 0, 1);
        if (length > 0 && /^\s/.test(new TextDecoder().decode(core.bytes({ pointer: piece, length: Math.min(length, 16) })))) prefix.shift();
      } finally {
        core.free({ pointer: piece });
      }
    }
    if (grammar && !params.grammar_lazy) for (const token of prefix) await api.llama_sampler_accept(grammar, token);
    const ends = params.thinking_end_tags;
    let endTags: string[];
    try {
      endTags = Array.from(ends);
    } finally {
      ends.delete();
    }
    if (grammar && params.grammar_lazy && params.thinking_start_tag && endTags.length) {
      const starts = new native.llama_token_sequences(); const stops = new native.llama_token_sequences(); const forced = new native.llama_tokens();
      try {
        for (const [target, texts] of [[starts, [params.thinking_start_tag]], [stops, endTags]] as const) {
          for (const text of texts) {
            const tokens = new native.llama_tokens();
            try {
              for (const token of await tokenizeChatText({ core, vocab, text })) tokens.push_back(token); target.push_back(tokens);
            } finally {
              tokens.delete();
            }
          }
        }
        budget = native.common_reasoning_budget_init(vocab, starts, stops, forced, 2147483647, native.common_reasoning_budget_state.REASONING_BUDGET_IDLE);
        if (!budget) throw new Error('Native reasoning state initialization failed');
      } finally {
        forced.delete(); stops.delete(); starts.delete();
      }
      for (const token of prefix) await api.llama_sampler_accept(budget, token);
    }
    if (grammar) {
      const options = core.allocRecord({ name: 'llama_sampler_chain_params' });
      try {
        await api.llama_sampler_chain_default_params(options); outer = await api.llama_sampler_chain_init(options);
      } finally {
        core.free({ pointer: options });
      }
      if (!outer) throw new Error('Native sampling chain initialization failed');
      await api.llama_sampler_chain_add(outer, grammar); grammarAttached = true;
      await api.llama_sampler_chain_add(outer, chain); chainAttached = true;
    }
    const grammarShouldApply = (): boolean => {
      if (!budget) return true;
      const state = native.common_reasoning_budget_get_state(budget).value;
      switch (state) {
      case 0: case 4: return true;
      case 1: case 2: case 3: return false;
      default: { const exhaustive: never = state; throw new Error(`Unknown reasoning state: ${exhaustive}`); }
      }
    };
    logDiagnostic({ diagnostic: { event: 'sampler-ready', grammar: !!grammar, grammarLazy: params.grammar_lazy, reasoning: !!budget, pointerBytes: core.pointerBytes } });
    return { dispose, preservedTokens,
      async sample({ context }: { context: bigint }): Promise<number> {
        let stage: DiagnosticStage = 'reasoning-state';
        try {
          const apply = grammarShouldApply();
          stage = 'grammar-switch';
          if (grammar && apply !== grammarAttached) {
            if (!apply) {
              await api.llama_sampler_chain_remove(outer, 0); grammarAttached = false;
            } else {
            // Reinsert before the distribution sampler, without copying vocabulary logits into JS.
              await api.llama_sampler_chain_remove(outer, 0); chainAttached = false;
              await api.llama_sampler_chain_add(outer, grammar); grammarAttached = true;
              await api.llama_sampler_chain_add(outer, chain); chainAttached = true;
            }
          }
          stage = 'native-sample';
          const token = await api.llama_sampler_sample(outer || chain, context, -1);
          if (budget) {
            stage = 'reasoning-accept';
            await api.llama_sampler_accept(budget, token);
            stage = 'reasoning-state';
            if (!apply && grammarShouldApply()) {
              // The matched end sequence can itself contain a grammar trigger.
              stage = 'reasoning-replay';
              const end = copyReasoningEndMatch({ core, budget });
              try {
                for (const token of end) await api.llama_sampler_accept(grammar, token);
              } finally {
                end.delete();
              }
            }
          }
          return token;
        } catch (error) {
          logFailure({ stage, error }); throw error;
        }
      },
    };
  } catch (error) {
    await dispose(); throw error;
  }
}
export function copyReasoningEndMatch({ core, budget }: { core: Core, budget: bigint }) {
  core.assertIdle();
  const copy = core.module.common_reasoning_budget_get_end_match_copy;
  if (!copy) {
    logDiagnostic({ diagnostic: { event: 'failed', stage: 'reasoning-replay', reason: 'missing-native-binding' } });
    throw new Error('The installed native runtime lacks the owned reasoning end-match binding');
  }
  return copy(budget);
}
export const TEST_ONLY = {
};
