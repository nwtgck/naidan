import type { Effect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';
import { EffectSyntaxError, parseEffectPrefix } from './expression.ts';

/** Deliberately conspicuous: this is a trusted exception, not an inferred fact. */
export const UNSAFE_SUPPRESSION_TAG = '@effectsUNSAFE';
export type UnsafeEffectSuppression = {
  start: number,
  end: number,
  effects: readonly Effect[],
  reason: string,
};

export function parseUnsafeSuppression({ text, definitions }: {
  text: string, definitions: readonly EffectDefinition[],
}): { effects: readonly Effect[], reason: string } {
  const parsed = parseEffectPrefix({ text, definitions, terminator: '--' });
  if (parsed.effects.length === 0 || parsed.effects.some(effect => effect.kind !== 'operation')) {
    throw new EffectSyntaxError({ message: 'Unsafe suppression requires named operations, not `none` or callback expressions.', offset: 0 });
  }
  if (!text.startsWith('--', parsed.end)) {
    throw new EffectSyntaxError({ message: 'Unsafe suppression requires -- followed by a quoted reason.', offset: parsed.end });
  }
  let offset = parsed.end + 2;
  while (' \t\r\n'.includes(text[offset] ?? '\0')) offset++;
  let reason: unknown;
  try {
    reason = JSON.parse(text.slice(offset));
  } catch {
    throw new EffectSyntaxError({ message: 'The unsafe suppression reason must be exactly one JSON string.', offset });
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2048
    || [...reason].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\u2028' || character === '\u2029')) {
    throw new EffectSyntaxError({ message: 'Use a nonblank, single-line unsafe suppression reason of at most 2048 characters.', offset });
  }
  return { effects: parsed.effects, reason };
}
