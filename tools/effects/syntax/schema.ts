import { z } from 'zod';
import { EffectSyntaxError } from './error.ts';

export const effectRowSchema = z.array(z.string());
export const effectEventMapSchema = z.record(z.string(), effectRowSchema);
export const unsafeSuppressionSchema = z.strictObject({
  effects: effectRowSchema,
  reason: z.string().max(2048).refine(reason => reason.trim().length > 0
    && ![...reason].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\u2028' || character === '\u2029'), {
    message: 'Use a nonblank, single-line unsafe suppression reason of at most 2048 characters.',
  }),
});

/** Keep malformed metadata in the ordinary source diagnostic path. */
export function parseEffectMetadata<T>({ schema, value }: { schema: z.ZodType<T>, value: unknown }): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EffectSyntaxError({ message: z.prettifyError(parsed.error), offset: 0 });
  return parsed.data;
}
