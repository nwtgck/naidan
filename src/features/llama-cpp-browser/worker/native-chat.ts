import type { ChatParams } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';

/** Native handles and their width-specific consumers stay inside one bound module. */
export function prepareChat({ core, model, request }: { core: Core, model: bigint, request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'> }) {
  return core.chat.prepare({ assertIdle: core.assertIdle, model, request });
}

/** Translate native grammar triggers to the low-level sampler ABI. */
export async function createGrammarSampler({ core, vocab, params, preservedTokens }: { core: Core, vocab: bigint, params: ChatParams, preservedTokens: ReadonlySet<number> }): Promise<bigint> {
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

export async function preservedTokenIds({ core, vocab, params }: { core: Core, vocab: bigint, params: ChatParams }): Promise<Set<number>> {
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
