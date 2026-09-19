/* eslint-disable no-restricted-imports -- Worker-only decode view uses the actual tokenizer type. */
import type { PreTrainedTokenizer } from '@huggingface/transformers';

/** Keep admitted tool framing without exposing unrelated special tokens.
 * The real TextStreamer still owns put/end; capture sees unmodified raw tokens.
 */
export function createToolStreamDecodeView({ tokenizer, preservedDelimiterIds }: {
  tokenizer: PreTrainedTokenizer; preservedDelimiterIds: readonly number[];
}): PreTrainedTokenizer {
  const specials = new Set(tokenizer.all_special_ids);
  if (preservedDelimiterIds.length !== 2 || new Set(preservedDelimiterIds).size !== 2
    || [...specials, ...preservedDelimiterIds].some(id => !Number.isSafeInteger(id) || id < 0)) {
    throw new Error('Invalid admitted tool delimiter token IDs');
  }
  const allowed = new Set(preservedDelimiterIds.map(BigInt));
  const excluded = new Set([...specials].map(BigInt).filter(id => !allowed.has(id)));
  const decode: typeof tokenizer.decode = (tokens, options) => {
    if (!Array.isArray(tokens)) throw new Error('The tool stream decoder requires a token array');
    const visible = tokens.map(BigInt).filter(token => !excluded.has(token));
    return visible.length === 0 ? '' : tokenizer.decode(visible, options);
  };
  return new Proxy(tokenizer, {
    get(target, property) {
      return property === 'decode' ? decode : Reflect.get(target, property, target);
    },
    set() {
      throw new Error('The tool stream tokenizer view is read-only');
    },
    defineProperty() {
      throw new Error('The tool stream tokenizer view is read-only');
    },
    deleteProperty() {
      throw new Error('The tool stream tokenizer view is read-only');
    },
  });
}

export const TEST_ONLY = {
};
