import { z } from 'zod';
import type * as dtozod from '@/utils/dtozod';

/** Native transform plumbing for the existing optional experimental DTO field. */
export function createOptionalExperimentalFieldSchema<T extends { readonly unreadable?: Readonly<Record<string, unknown>> }>({ read }: {
  read({ raw }: { raw: unknown }): T,
}): dtozod.DtoLeaf<z.ZodOptional<z.ZodType<T, unknown>>> {
  const transformed = z.unknown().transform(raw => read({ raw }));
  return transformed.optional() as unknown as dtozod.DtoLeaf<z.ZodOptional<z.ZodType<T, unknown>>>;
}

export const TEST_ONLY = {
};
