import { z } from 'zod';

/**
 * Utilities for preserving omitted object fields as own keys with `undefined`.
 *
 * The goal of this file is intentionally small:
 *
 * ```ts
 * resolveMissingAsUndefined(z.object({
 *   a: missingAsUndefined(z.string()),
 * })).parse({})
 * // { a: undefined }
 * ```
 *
 * Naidan intentionally prefers required object keys whose value may be
 * `undefined` over optional object keys.
 *
 * Optional properties are easy to forget. When a key is optional, omitting it
 * can mean either "this field is intentionally absent" or "the author forgot to
 * set it". Requiring the key and using `undefined` makes the absence explicit:
 * reviewers can see that the field was considered.
 *
 * This matters for DTOs and other JSON-like boundary schemas because they are
 * reviewed as long-term data contracts. Explicit `key: undefined` values make
 * TypeScript usage and code review stricter, while still allowing persisted JSON
 * to stay compact.
 *
 * We do not use `null` for this purpose because `null` is serialized and stored.
 * `undefined` disappears during JSON serialization, so saved records can remain
 * compact while parsed in-memory DTOs still have explicit own keys.
 *
 * Zod can accept missing keys with `.optional()`, but it preserves them as
 * missing keys. This file exists because we want a different parsed shape:
 * missing input keys should become own keys whose value is `undefined`.
 *
 * Most of the complexity in this file exists only because Zod does not have a
 * built-in "default to an own key whose value is undefined" primitive. Keep the
 * call sites simple and reviewable; keep the workaround contained here.
 */

const missingAsUndefinedSentinel: symbol = Symbol('missingAsUndefined');

const missingAsUndefinedSentinelSchema = z.custom<symbol>(
  (value): value is symbol => value === missingAsUndefinedSentinel,
);

/**
 * Keeps the concrete Zod schema type while replacing the input/output slots
 * used by `z.input<typeof schema>` and `z.output<typeof schema>`.
 *
 * Why this compromise exists:
 *
 * A simple cast like this looks tempting:
 *
 * ```ts
 * result as typeof result & z.ZodType<Output, Input>
 * ```
 *
 * But Zod object inference also observes the internal `_zod.input` /
 * `_zod.output` type slots. Without replacing those slots, the private sentinel
 * type can leak into DTO output types.
 *
 * We intentionally keep this compromise private to this file. Runtime behavior
 * does not depend on Zod internals; this is only a compile-time bridge so call
 * sites can stay simple and so we do not need to expose raw schemas or an
 * intermediate sentinel type.
 *
 * Alternatives intentionally not used:
 *
 * - Expose an intermediate sentinel type and require a resolver to erase
 *   it at the type level. That is more type-honest, but it made ordinary Zod
 *   4.4 migration diffs much harder to audit and encouraged raw schema exports.
 * - Recreate Zod optionality metadata such as `_zod.optin` / `_zod.optout`.
 *   That couples us more tightly to Zod's object optionality rules. Here we keep
 *   Zod's generated schema type and only adjust input/output type slots.
 */
type WithZodIO<Schema extends z.ZodType, Output, Input> =
  Omit<Schema, '_zod'> &
    z.ZodType<Output, Input> & {
      _zod: Omit<Schema['_zod'], 'output' | 'input'> & {
        output: Output;
        input: Input;
      };
    };

/**
 * Marks an object field whose omitted input key should become
 * `key: undefined` after parsing.
 *
 * `.optional()` accepts a missing key but keeps it missing:
 *
 * ```ts
 * z.object({ a: z.string().optional() }).parse({})
 * // {}
 * ```
 *
 * `.default(undefined)` is also not enough, because Zod object parsing still
 * omits a missing key when the parsed field value is `undefined`.
 *
 * Therefore this helper first defaults the field to a private non-undefined
 * sentinel. That forces Zod to materialize the key. The enclosing object schema
 * must then be wrapped with `resolveMissingAsUndefined(...)`, which replaces
 * the private sentinel with real `undefined`.
 *
 * The sentinel is intentionally private and is not exposed in public types.
 * We considered exposing an intermediate sentinel type and resolving it at the
 * type level, but that made ordinary Zod 4.4 migration diffs much harder to
 * review and encouraged raw/unresolved schema exports.
 */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this local Zod helper intentionally mirrors Zod's schema-first helper style.
export const missingAsUndefined = <T extends z.ZodType>(
  schema: T,
) => {
  const result = z
    .union([schema, missingAsUndefinedSentinelSchema])
    .optional()
    .default(missingAsUndefinedSentinel);

  return result as WithZodIO<
    typeof result,
    z.output<T> | undefined,
    z.input<T> | undefined
  >;
};

/**
 * Shallowly replaces private sentinels inserted by `missingAsUndefined(...)`
 * with real `undefined` values.
 *
 * This is intentionally shallow. If a nested object also uses
 * `missingAsUndefined(...)`, wrap that nested object with
 * `resolveMissingAsUndefined(...)` too.
 *
 * Explicit wrappers make DTO diffs easier to audit than a recursive global
 * walk. A recursive resolver would hide which nested schemas depend on this
 * behavior.
 */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Zod .overwrite callbacks receive the parsed value positionally.
const resolveMissingAsUndefinedValue = <T extends object>(
  value: T,
): T => {
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;

    if (record[key] === missingAsUndefinedSentinel) {
      record[key] = undefined;
    }
  }

  return value;
};

// eslint-disable-next-line local-rules-named-args/require-named-args -- Zod .overwrite callback types are positional by Zod API design.
type ZodOverwriteCallback<T extends z.ZodType<object, unknown>> = (
  value: z.output<T>
) => z.output<T>;

/**
 * Resolves `missingAsUndefined(...)` fields on an object-output schema.
 *
 * Keep ordinary Zod object construction visible at call sites:
 *
 * ```ts
 * const Schema = resolveMissingAsUndefined(z.object({
 *   a: missingAsUndefined(z.string()),
 * }));
 * ```
 *
 * A shape-based helper such as `resolveMissingAsUndefined({ ... })` would be
 * shorter, but it would hide object construction and make the schema look less
 * like standard Zod.
 *
 * `.overwrite(...)` is used because this is not a domain-level transform. It is
 * only a normalization step that removes a private implementation sentinel.
 *
 * Extension note:
 *
 * `.overwrite(...)` makes Zod treat the object as having checks.
 *
 * - Adding new keys with `.extend(...)` works.
 * - Overwriting existing keys with `.extend(...)` can throw at runtime.
 * - Prefer `.safeExtend(...)` for compatible overrides.
 * - Use a local shape spread for incompatible overrides:
 *
 * ```ts
 * const RemoteSchema = resolveMissingAsUndefined(z.object({
 *   ...BaseSchema.shape,
 *   name: z.union([z.string(), z.null()]),
 * }));
 * ```
 */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this local Zod helper intentionally mirrors Zod's schema-first helper style.
export const resolveMissingAsUndefined = <
  T extends z.ZodType<object, unknown>
>(
    schema: T,
  ): T =>
  schema.overwrite(
    resolveMissingAsUndefinedValue as ZodOverwriteCallback<T>,
  ) as T;
