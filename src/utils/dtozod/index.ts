/**
 * Structural schemas for persisted Data Transfer Objects (DTOs).
 *
 * Intentionally absent: refinement/check APIs, strictness switches, custom,
 * transforms, unconstrained native schemas, and public unwrap functions.
 * Unknown fields should not prevent older versions from reading persisted DTOs.
 * _zod exposes type slots only, never native def/run/parse/constr internals.
 * Runtime schemas ARE Zod schemas: this is a static policy, not a sandbox.
 * Required phantom symbols are compiler-only provenance, not runtime markers.
 *
 * Deliberately NOT exposed (do not "complete" this API to match all of Zod):
 * - strict/strictObject/catchall: newer fields must not prevent downgrade loads.
 *   Unknown keys are discarded by object(); losing them on resave is accepted.
 * - refine/superRefine/check/min/max/regex/int/transform/overwrite: DTOs express
 *   TypeScript structures, not domain invariants. Removing a check does not
 *   require recreating it elsewhere; defend only operations that need it.
 * - unwrap/fromZod/custom/any: these would defeat the allowlist or type safety.
 * - native schemas through shape/element/options or a chained method's result.
 *
 * default is intentional for legacy missing data; exactOptional distinguishes
 * versioned structures. The missingAsUndefined/resolveMissingAsUndefined and
 * optionalExperimentalFieldSchemaDto compatibility contracts are intentional.
 *
 * _zod's slots and the brands exist for inference, NOT runtime reads. In
 * particular, z.input/z.output/z.infer remain compatible without exposing Zod's
 * executable internals. Re-run the type and runtime parity tests on Zod updates;
 * the assertions below do not prove future signature compatibility.
 *
 * The positional signatures intentionally follow Zod; suppress locally rather
 * than changing Naidan's named-arguments lint rule.
 * Test-only exports must never become a raw-schema escape hatch.
 */
/* eslint-disable local-rules-named-args/require-named-args -- This type-only dialect intentionally mirrors Zod's positional API. */
import { z } from 'zod';

declare const dtoSchemaBrand: unique symbol;
declare const discriminableBrand: unique symbol;
interface DiscriminableToken extends SchemaToken { readonly [discriminableBrand]: true; }
type Slots = 'input' | 'output' | 'optin' | 'optout';
type Metadata = Pick<z.ZodType['_zod'], Slots>;

interface SchemaToken {
  readonly [dtoSchemaBrand]: true;
  readonly _zod: { readonly optin?: 'optional' | undefined; readonly optout?: 'optional' | undefined };
}
export interface DtoSchema extends SchemaToken {
  readonly _zod: Metadata;
  parse(data: unknown): z.output<this>;
  safeParse(data: unknown): z.ZodSafeParseResult<z.output<this>>;
  optional(): DtoOptional<this>;
  exactOptional(): DtoExactOptional<this>;
  nullable(): DtoNullable<this>;
  array(): DtoArray<this>;
  default(value: z.util.NoUndefined<z.output<this>>): DtoDefault<this>;
  default(value: () => z.util.NoUndefined<z.output<this>>): DtoDefault<this>;
}
interface NativeInternals<T extends SchemaToken> extends z.core.$ZodTypeInternals {
  output: z.output<T>;
  input: z.input<T>;
  optin: T['_zod']['optin'];
  optout: T['_zod']['optout'];
}
type Native<T extends SchemaToken> = z.ZodType<z.output<T>, z.input<T>, NativeInternals<T>>;
export type DtoShape = Readonly<Record<string, SchemaToken>>;
type NativeShape<T extends DtoShape> = { -readonly [K in keyof T]: Native<T[K]> };
type NativeOptions<T extends readonly SchemaToken[]> = { -readonly [K in keyof T]: Native<T[K]> };

export interface DtoLeaf<T extends z.ZodType> extends DtoSchema {
  readonly _zod: Readonly<Pick<T['_zod'], Slots>>;
}
export interface DtoOptional<T extends SchemaToken> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodOptional<Native<T>>['_zod'], Slots>>;
}
export interface DtoExactOptional<T extends SchemaToken> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodExactOptional<Native<T>>['_zod'], Slots>>;
}
export interface DtoNullable<T extends SchemaToken> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodNullable<Native<T>>['_zod'], Slots>>;
}
export interface DtoDefault<T extends SchemaToken> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodDefault<Native<T>>['_zod'], Slots>>;
}
interface ArrayMetadata<T extends SchemaToken> extends Metadata {
  output: z.output<T>[];
  input: z.input<T>[];
}
export interface DtoArray<T extends SchemaToken> extends DtoSchema {
  readonly _zod: ArrayMetadata<T>;
  readonly element: T;
}
interface UnionMetadata<T extends readonly SchemaToken[]> extends Metadata {
  output: z.output<T[number]>;
  input: z.input<T[number]>;
  optin: z.ZodUnion<NativeOptions<T>>['_zod']['optin'];
  optout: z.ZodUnion<NativeOptions<T>>['_zod']['optout'];
}
export interface DtoUnion<T extends readonly SchemaToken[]> extends DtoSchema {
  readonly _zod: UnionMetadata<T>;
  readonly options: Readonly<T>;
}
type SafeShape<Base extends DtoShape, Ext extends DtoShape> = {
  [K in keyof Ext]: [z.SafeExtendShape<NativeShape<Base>, NativeShape<Ext>>[K]] extends [never] ? never : Ext[K]
};
interface ObjectMetadata<S extends DtoShape> extends Metadata {
  output: z.core.$InferObjectOutput<S, Record<never, never>>;
  input: z.core.$InferObjectInput<S, Record<never, never>>;
}
export interface DtoObject<S extends DtoShape> extends DtoSchema, DiscriminableToken {
  readonly _zod: ObjectMetadata<S>;
  readonly shape: Readonly<S>;
  extend<const U extends DtoShape>(shape: U): DtoObject<z.util.Extend<S, U>>;
  safeExtend<const U extends DtoShape>(shape: U & SafeShape<S, U>): DtoObject<z.util.Extend<S, U>>;
  pick<const M extends z.util.Mask<keyof S>>(mask: M & Record<Exclude<keyof M, keyof S>, never>): DtoObject<Pick<S, Extract<keyof S, keyof M>>>;
  omit<const M extends z.util.Mask<keyof S>>(mask: M & Record<Exclude<keyof M, keyof S>, never>): DtoObject<Omit<S, Extract<keyof S, keyof M>>>;
}
export type infer<T extends SchemaToken> = z.output<T>;
export type input<T extends SchemaToken> = z.input<T>;
export type output<T extends SchemaToken> = z.output<T>;
export const string = z.string as unknown as () => DtoLeaf<z.ZodString>;
export const number = z.number as unknown as () => DtoLeaf<z.ZodNumber>;
export const boolean = z.boolean as unknown as () => DtoLeaf<z.ZodBoolean>;
const createUndefined = z.undefined as unknown as () => DtoLeaf<z.ZodUndefined>;
export { createUndefined as undefined };
export const never = z.never as unknown as () => DtoLeaf<z.ZodNever>;
export const unknown = z.unknown as unknown as () => DtoLeaf<z.ZodUnknown>;
export const literal = z.literal as unknown as <const T extends string | number | boolean | null>(
  value: T,
) => DtoLeaf<z.ZodLiteral<T>>;
const createEnum = z.enum as unknown as <const T extends readonly string[]>(
  values: T,
) => DtoLeaf<z.ZodEnum<z.util.ToEnum<T[number]>>>;
export { createEnum as enum };
export const object = z.object as unknown as <S extends DtoShape>(shape: S) => DtoObject<S>;
export const array = z.array as unknown as <T extends SchemaToken>(schema: T) => DtoArray<T>;
export const union = z.union as unknown as <T extends readonly [SchemaToken, ...SchemaToken[]]>(
  options: T,
) => DtoUnion<T>;
// Discriminator key validity still follows Zod's runtime validation; require object/DU categories.
export interface DtoDiscriminatedUnion<T extends readonly DiscriminableToken[]> extends DtoUnion<T> { readonly [discriminableBrand]: true; }
type DiscriminableInput<Disc extends string> = DiscriminableToken & {
  readonly _zod: { readonly input: { [K in Disc]?: unknown } };
};
export const discriminatedUnion = z.discriminatedUnion as unknown as <
  T extends readonly [DiscriminableInput<Disc>, ...DiscriminableInput<Disc>[]],
  Disc extends string,
>(key: Disc, options: T) => DtoDiscriminatedUnion<T>;

export interface DtoTuple<T extends readonly SchemaToken[]> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodTuple<NativeOptions<T>, null>['_zod'], Slots>>;
}
export interface DtoRecord<K extends SchemaToken, V extends SchemaToken> extends DtoSchema {
  readonly _zod: Readonly<Pick<z.ZodRecord<Native<K> & z.core.$ZodRecordKey, Native<V>>['_zod'], Slots>>;
}
export const tuple = z.tuple as unknown as <T extends readonly [SchemaToken, ...SchemaToken[]]>(items: T) => DtoTuple<T>;
export const record = z.record as unknown as <
  K extends SchemaToken & { readonly _zod: { readonly output: PropertyKey } },
  V extends SchemaToken,
>(key: K, value: V) => DtoRecord<K, V>;


// No test-only raw-schema accessor: these are native aliases, not a sandbox.
export const TEST_ONLY = {
};
