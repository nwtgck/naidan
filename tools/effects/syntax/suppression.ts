import type { Effect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';
import { EffectSyntaxError, parseEffectRow } from './expression.ts';
import { parseJsonPayload } from './json.ts';
import { parseEffectMetadata, unsafeSuppressionSchema } from './schema.ts';

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
  const { effects: row, reason } = parseEffectMetadata({ schema: unsafeSuppressionSchema, value: parseJsonPayload({ text }) });
  const effects = parseEffectRow({ value: row, definitions });
  if (effects.length === 0 || effects.some(effect => effect.kind !== 'operation')) {
    throw new EffectSyntaxError({ message: 'Unsafe suppression requires named operations, not an empty row or callback expressions.', offset: 0 });
  }
  return { effects, reason };
}
