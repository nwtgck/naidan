import { randomInt, type SeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';
import { pickWeighted } from '@/features/fake-lm/core/weighted';

export type FakeLmThinkingEffort = 'off' | 'low' | 'medium' | 'high';

export type FakeLmStreamItem =
  | { type: 'thinking', chunk: string }
  | { type: 'content', chunk: string };

export function normalizeFakeLmThinkingEffort({ value }: {
  value: unknown,
}): FakeLmThinkingEffort {
  if (value === undefined || value === null || value === false) {
    return 'off';
  }

  if (value === true) {
    return 'medium';
  }

  if (typeof value === 'object') {
    const effort = (value as { effort?: unknown }).effort;
    return normalizeFakeLmThinkingEffort({ value: effort });
  }

  if (typeof value !== 'string') {
    return 'off';
  }

  switch (value.trim().toLowerCase()) {
  case 'off':
  case 'none':
  case 'disabled':
  case 'false':
    return 'off';
  case 'low':
    return 'low';
  case 'med':
  case 'medium':
  case 'true':
    return 'medium';
  case 'high':
  case 'xhigh':
    return 'high';
  default:
    return 'off';
  }
}

export function makeFakeLmThinkingSentenceCount({ effort, random }: {
  effort: FakeLmThinkingEffort,
  random: SeededNonCryptoPseudoRandom,
}): number {
  switch (effort) {
  case 'off':
    return 0;
  case 'low':
    return pickWeighted({
      random,
      items: [
        { value: 6, weight: 20 },
        { value: 7, weight: 35 },
        { value: 8, weight: 30 },
        { value: 9, weight: 15 },
      ],
    });
  case 'medium':
    return pickWeighted({
      random,
      items: [
        { value: 16, weight: 12 },
        { value: 17, weight: 16 },
        { value: 18, weight: 20 },
        { value: 19, weight: 18 },
        { value: 20, weight: 14 },
        { value: 21, weight: 10 },
        { value: 22, weight: 6 },
        { value: 23, weight: 3 },
        { value: 24, weight: 1 },
      ],
    });
  case 'high':
    return randomInt({ random, min: 96, max: 160 });
  default: {
    const _ex: never = effort;
    throw new Error(`Unhandled fake LM thinking effort: ${String(_ex)}`);
  }
  }
}

export function makeFakeLmThinkingParagraphBreakEvery({ effort }: {
  effort: FakeLmThinkingEffort,
}): number | undefined {
  switch (effort) {
  case 'off':
  case 'low':
    return undefined;
  case 'medium':
    return 6;
  case 'high':
    return 8;
  default: {
    const _ex: never = effort;
    throw new Error(`Unhandled fake LM thinking effort: ${String(_ex)}`);
  }
  }
}

export function makeFakeLmThinkingChunking({ effort }: {
  effort: FakeLmThinkingEffort,
}): { minChars: number, maxChars: number, delayMs: number } {
  switch (effort) {
  case 'off':
    return { minChars: 0, maxChars: 0, delayMs: 0 };
  case 'low':
    return { minChars: 10, maxChars: 28, delayMs: 55 };
  case 'medium':
    return { minChars: 10, maxChars: 30, delayMs: 50 };
  case 'high':
    return { minChars: 18, maxChars: 48, delayMs: 30 };
  default: {
    const _ex: never = effort;
    throw new Error(`Unhandled fake LM thinking effort: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
