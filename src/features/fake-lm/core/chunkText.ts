import { randomInt, type SeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';

export function* chunkText({ text, random, minChars, maxChars }: {
  text: string,
  random: SeededNonCryptoPseudoRandom,
  minChars: number,
  maxChars: number,
}): Iterable<string> {
  const chars = Array.from(text);
  let index = 0;

  while (index < chars.length) {
    const size = randomInt({ random, min: minChars, max: maxChars });
    yield chars.slice(index, index + size).join('');
    index += size;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
