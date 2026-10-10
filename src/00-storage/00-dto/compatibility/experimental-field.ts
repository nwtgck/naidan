import { z } from 'zod';
import type * as dtozod from '@/utils/dtozod';

const ExperimentalUnreadableRootKey = '_root';

type ExperimentalUnreadable = Readonly<Record<string, unknown>>;

type ExperimentalOutput<TSchema extends { _zod: { output: unknown } }> = z.output<TSchema> & {
  readonly unreadable?: ExperimentalUnreadable,
};

const attachUnreadable = <T extends object>({
  value,
  unreadable,
}: {
  value: T,
  unreadable: ExperimentalUnreadable,
}): T => {
  Object.defineProperty(value, 'unreadable', {
    value: unreadable,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return value;
};

const nativeOptionalExperimentalFieldSchemaDto = <TSchema extends z.ZodObject>({
  schema,
}: {
  schema: TSchema,
}) => {
  // Experimental fields intentionally break the normal DTO rule that new optional
  // persisted fields should materialize as `key: undefined`. This helper is used
  // broadly across DTO objects, so emitting `experimental: undefined` everywhere
  // would add runtime overhead and review noise. The field itself is therefore
  // optional, while fields inside the experimental object still use normal DTO
  // schema rules.
  const transformed = z.unknown().transform((raw): ExperimentalOutput<TSchema> => {
    const empty = schema.parse({}) as ExperimentalOutput<TSchema>;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return attachUnreadable({
        value: empty,
        unreadable: { [ExperimentalUnreadableRootKey]: raw },
      });
    }

    // Keep own-property checks and plain dictionaries: inherited
    // names are unknown data, and __proto__ must never invoke a setter.
    const input = raw as Record<string, unknown>;
    const valueInput: Record<string, unknown> = {};
    const unreadable: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(input)) {
      const fieldSchema = Object.hasOwn(schema.shape, key) ? schema.shape[key] : undefined;

      if (fieldSchema === undefined) {
        Object.defineProperty(unreadable, key, { value: rawValue, enumerable: true, configurable: true, writable: true });
        continue;
      }

      const result = fieldSchema.safeParse(rawValue);

      if (result.success) {
        // The full object parser must receive input, not an already transformed
        // output. Reparsing result.data loses nested non-enumerable unreadable
        // evidence and can reinterpret a compatibility helper's output.
        Object.defineProperty(valueInput, key, { value: rawValue, enumerable: true, configurable: true, writable: true });
      } else {
        Object.defineProperty(unreadable, key, { value: rawValue, enumerable: true, configurable: true, writable: true });
      }
    }

    const value = schema.parse(valueInput) as ExperimentalOutput<TSchema>;
    return Object.keys(unreadable).length === 0
      ? value
      : attachUnreadable({ value, unreadable });
  }) as z.ZodType<ExperimentalOutput<TSchema>, unknown>;

  return transformed.optional();
};


/**
 * A narrowly scoped compatibility boundary, not a generic schema importer.
 * Keep missing experimental fields absent and isolate unreadable fields instead
 * of refusing the containing DTO. Do not expose arbitrary transforms in dtozod.
 */
export const optionalExperimentalFieldSchemaDto = nativeOptionalExperimentalFieldSchemaDto as unknown as <
  TSchema extends dtozod.DtoObject<dtozod.DtoShape>,
>({ schema }: { schema: TSchema }) => dtozod.DtoLeaf<
  z.ZodOptional<z.ZodType<ExperimentalOutput<TSchema>, unknown>>
>;

export const TEST_ONLY = {
};
