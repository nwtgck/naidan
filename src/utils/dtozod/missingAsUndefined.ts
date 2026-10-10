import type { z } from 'zod';
import type { DtoLeaf, DtoSchema, input, output } from '@/utils/dtozod';
import {
  missingAsUndefined as nativeMissingAsUndefined,
  resolveMissingAsUndefined as nativeResolveMissingAsUndefined,
} from '@/utils/zod/missingAsUndefined';

/**
 * The existing compatibility functions, with DTO-only signatures.
 * No runtime wrapper or generic unwrap/fromZod escape hatch is added.
 *
 * Every enclosing object using missingAsUndefined MUST also use
 * resolveMissingAsUndefined; nested objects need their own resolver. Otherwise
 * the native helper's private sentinel can escape despite the declared type.
 * Keep the native helper's overwrite and input/output optionality semantics.
 *
 * With resolved objects, use safeExtend for compatible replacements; pick/omit
 * must precede the resolver (native Zod rejects selection on checked objects).
 */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Alias of Zod's positional schema-first compatibility helper.
export const missingAsUndefined = nativeMissingAsUndefined as unknown as <T extends DtoSchema>(
  schema: T,
) => DtoLeaf<ReturnType<typeof nativeMissingAsUndefined<z.ZodType<output<T>, input<T>>>>>;

// eslint-disable-next-line local-rules-named-args/require-named-args -- Alias of Zod's positional schema-first compatibility helper.
export const resolveMissingAsUndefined = nativeResolveMissingAsUndefined as unknown as <
  T extends DtoSchema & { readonly _zod: { readonly output: object } },
>(schema: T) => T;

export const TEST_ONLY = {
};
