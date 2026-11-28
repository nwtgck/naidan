import type * as dtozod from '@/utils/dtozod';
import { createOptionalExperimentalFieldSchema } from '@/utils/persistence-compatibility/optional-experimental-field';

const ExperimentalUnreadableRootKey = '_root';

type ExperimentalUnreadable = Readonly<Record<string, unknown>>;

type ExperimentalOutput<TSchema extends dtozod.DtoObject<dtozod.DtoShape>> = dtozod.output<TSchema> & {
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

function readExperimentalField<TSchema extends dtozod.DtoObject<dtozod.DtoShape>>({ schema, raw }: {
  schema: TSchema, raw: unknown,
}): ExperimentalOutput<TSchema> {
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

  // The existing object fields are structural DTO schemas at runtime.
  const shape = schema.shape as Readonly<Record<string, dtozod.DtoSchema>>;
  for (const [key, rawValue] of Object.entries(input)) {
    const fieldSchema = Object.hasOwn(shape, key) ? shape[key] : undefined;

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
}

/** Keep a missing field absent and isolate unreadable values within the optional field. */
export function optionalExperimentalFieldDtoSchema<TSchema extends dtozod.DtoObject<dtozod.DtoShape>>({ schema }: { schema: TSchema }) {
  return createOptionalExperimentalFieldSchema({
    read: ({ raw }): ExperimentalOutput<TSchema> => readExperimentalField({ schema, raw }),
  });
}

export const TEST_ONLY = {
};
