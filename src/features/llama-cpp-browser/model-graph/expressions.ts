import { z } from 'zod';

export const graphNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.${}+-]{0,191}$/);
export type GraphMetadataValue = string | number | boolean | readonly (string | number | boolean)[];
/** Metadata storage is a contract, not an implicit scalar/array coercion.
 * Indexed scalars require explicit broadcast and a checked logical length.
 * Fallbacks apply only to an absent key, never invalid types or array lengths. */
export type GraphMetadataReference =
  | { metadata: string; index?: never; length?: never; scalar?: never; fallback?: never }
  | { metadata: string; index: GraphNumber; length?: GraphNumber; scalar?: never; fallback?: never }
  | { metadata: string; fallback: GraphNumber; index?: never; length?: never; scalar?: never }
  | { metadata: string; index: GraphNumber; length: GraphNumber; scalar: 'broadcast'; fallback?: GraphNumber };
export type GraphNumber = number
  | { parameter: string } | { variable: string }
  | GraphMetadataReference
  | { tensor: string; dimension: number }
  | { inputTokens: true } | { cacheTokens: true } | { capacity: true }
  | { sum: GraphNumber[] } | { product: GraphNumber[] }
  | { subtract: [GraphNumber, GraphNumber] } | { quotient: [GraphNumber, GraphNumber] }
  | { modulo: [GraphNumber, GraphNumber] } | { power: [GraphNumber, GraphNumber] }
  | { minimum: GraphNumber[] } | { maximum: GraphNumber[] } | { sqrt: GraphNumber };

function graphMetadataShapes() {
  const metadata = z.string().min(1).max(256);
  return [
    { metadata },
    { metadata, index: graphNumberSchema, length: graphNumberSchema.optional() },
    { metadata, fallback: graphNumberSchema },
    { metadata, index: graphNumberSchema, length: graphNumberSchema, scalar: z.literal('broadcast'), fallback: graphNumberSchema.optional() },
  ] as const;
}

export const graphNumberSchema: z.ZodType<GraphNumber> = z.lazy(() => {
  const [scalar, indexed, defaulted, broadcast] = graphMetadataShapes();
  return z.union([
    z.number().finite(),
    z.strictObject({ parameter: graphNameSchema }), z.strictObject({ variable: graphNameSchema }),
    z.strictObject(scalar), z.strictObject(indexed), z.strictObject(defaulted), z.strictObject(broadcast),
    z.strictObject({ tensor: z.string().min(1).max(256), dimension: z.number().int().min(0).max(3) }),
    z.strictObject({ inputTokens: z.literal(true) }), z.strictObject({ cacheTokens: z.literal(true) }), z.strictObject({ capacity: z.literal(true) }),
    z.strictObject({ sum: z.array(graphNumberSchema).min(2).max(16) }),
    z.strictObject({ product: z.array(graphNumberSchema).min(2).max(16) }),
    z.strictObject({ subtract: z.tuple([graphNumberSchema, graphNumberSchema]) }),
    z.strictObject({ quotient: z.tuple([graphNumberSchema, graphNumberSchema]) }),
    z.strictObject({ modulo: z.tuple([graphNumberSchema, graphNumberSchema]) }),
    z.strictObject({ power: z.tuple([graphNumberSchema, graphNumberSchema]) }),
    z.strictObject({ minimum: z.array(graphNumberSchema).min(2).max(16) }),
    z.strictObject({ maximum: z.array(graphNumberSchema).min(2).max(16) }),
    z.strictObject({ sqrt: graphNumberSchema }),
  ]);
});
export type GraphCondition =
  | { compare: 'equal' | 'notEqual' | 'less' | 'lessEqual' | 'greater' | 'greaterEqual'; left: GraphNumber; right: GraphNumber }
  | (GraphMetadataReference & { equals: string | number | boolean })
  | { all: GraphCondition[] } | { any: GraphCondition[] } | { not: GraphCondition };
export const graphConditionSchema: z.ZodType<GraphCondition> = z.lazy(() => {
  const [scalar, indexed, defaulted, broadcast] = graphMetadataShapes();
  const equals = z.union([z.string(), z.number().finite(), z.boolean()]);
  return z.union([
    z.strictObject({ compare: z.enum(['equal', 'notEqual', 'less', 'lessEqual', 'greater', 'greaterEqual']), left: graphNumberSchema, right: graphNumberSchema }),
    z.strictObject({ ...scalar, equals }), z.strictObject({ ...indexed, equals }), z.strictObject({ ...defaulted, equals }), z.strictObject({ ...broadcast, equals }),
    z.strictObject({ all: z.array(graphConditionSchema).min(1).max(16) }),
    z.strictObject({ any: z.array(graphConditionSchema).min(1).max(16) }),
    z.strictObject({ not: graphConditionSchema }),
  ]);
});
export type GraphExpressionEnvironment = {
  parameters: ReadonlyMap<string, number>;
  variables: ReadonlyMap<string, number>;
  metadata: ReadonlyMap<string, GraphMetadataValue>;
  tensors: ReadonlyMap<string, { shape: readonly number[] }>;
  inputTokens: number | undefined; cacheTokens: number | undefined; capacity: number | undefined;
};

/** Closed arithmetic, not JavaScript or a callback language. Every recursive
 * evaluation shares a bounded work counter, including metadata and loop bounds. */
export function createGraphExpressionEvaluator({ environment, maximumSteps }: { environment: GraphExpressionEnvironment; maximumSteps: number }) {
  let steps = 0;
  const tick = ({ depth }: { depth: number }): void => {
    if (++steps > maximumSteps || depth > 48) {
      throw new Error('Model graph expression budget exceeded');
    }
  };
  const metadataValue = ({ reference, depth }: { reference: GraphMetadataReference; depth: number }): GraphMetadataValue | undefined => {
    const { metadata: key, index, length, scalar, fallback, ...unhandled } = reference;
    unhandled satisfies Record<PropertyKey, never>;
    const value = environment.metadata.get(key);
    if (index === undefined) {
      // Presence is distinct from validity: a provided wrong type must not
      // borrow a fallback that was intended only for older/missing metadata.
      return !environment.metadata.has(key) && fallback !== undefined
        ? evaluate({ value: fallback, depth: depth + 1 }) : value;
    }
    const offset = evaluate({ value: index, depth: depth + 1 });
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Metadata array index must be a non-negative integer: ${key} (index ${offset})`);
    }
    const expected = length === undefined ? undefined : evaluate({ value: length, depth: depth + 1 });
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) {
      throw new Error(`Metadata array length must be a positive integer: ${key} (length ${expected})`);
    }
    if (expected !== undefined && offset >= expected) {
      throw new Error(`Metadata array index is outside its declared array: ${key} (index ${offset}, declared length ${expected})`);
    }
    if (Array.isArray(value)) {
      if (expected !== undefined && value.length !== expected) {
        throw new Error(`Metadata array length mismatch: ${key} (expected ${expected}, received ${value.length})`);
      }
      if (offset >= value.length || !Object.hasOwn(value, offset) || value[offset] === undefined) {
        throw new Error(`Metadata array index is outside its declared array: ${key} (index ${offset}, actual length ${value.length})`);
      }
      return value[offset];
    }
    switch (scalar) {
    case 'broadcast':
      // Schema validation requires a logical length for broadcast. Keep the
      // same check for typed compiler callers that bypass the parser.
      if (expected === undefined) {
        throw new Error(`Scalar metadata broadcast requires a declared length: ${key}`);
      }
      if (!environment.metadata.has(key)) {
        if (fallback !== undefined) {
          return evaluate({ value: fallback, depth: depth + 1 });
        }
        throw new Error(`Missing model metadata: ${key}`);
      }
      return value;
    case undefined:
      if (!environment.metadata.has(key)) {
        throw new Error(`Missing model metadata array: ${key}`);
      }
      throw new Error(`Expected metadata array: ${key} (received ${typeof value}; scalar broadcast must be declared explicitly)`);
    default: {
      const exhaustive: never = scalar;
      throw new Error(String(exhaustive));
    }
    }
  };
  const evaluate = ({ value, depth }: { value: GraphNumber; depth: number }): number => {
    tick({ depth });
    const recurse = ({ term }: { term: GraphNumber }) => evaluate({ value: term, depth: depth + 1 });
    const result = (() => {
      if (typeof value === 'number') {
        return value;
      }
      if ('parameter' in value) {
        return environment.parameters.get(value.parameter);
      }
      if ('variable' in value) {
        return environment.variables.get(value.variable);
      }
      if ('metadata' in value) {
        const found = metadataValue({ reference: value, depth });
        if (typeof found !== 'number') {
          throw new Error(`Expected numeric model metadata: ${value.metadata}`);
        }
        return found;
      }
      if ('tensor' in value) {
        return environment.tensors.get(value.tensor)?.shape[value.dimension];
      }
      if ('inputTokens' in value) {
        return environment.inputTokens;
      }
      if ('cacheTokens' in value) {
        return environment.cacheTokens;
      }
      if ('capacity' in value) {
        return environment.capacity;
      }
      if ('sum' in value) {
        return value.sum.reduce<number>((sum, term) => sum + recurse({ term: term }), 0);
      }
      if ('product' in value) {
        return value.product.reduce<number>((product, term) => product * recurse({ term: term }), 1);
      }
      if ('subtract' in value) {
        return recurse({ term: value.subtract[0] }) - recurse({ term: value.subtract[1] });
      }
      if ('quotient' in value) {
        const denominator = recurse({ term: value.quotient[1] });
        if (denominator === 0) {
          throw new Error('Division by zero in model graph declaration');
        }
        return recurse({ term: value.quotient[0] }) / denominator;
      }
      if ('modulo' in value) {
        const a = recurse({ term: value.modulo[0] }), b = recurse({ term: value.modulo[1] });
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0) {
          throw new Error('Modulo requires exact integer operands and a positive divisor');
        }
        return ((a % b) + b) % b;
      }
      if ('power' in value) {
        return Math.pow(recurse({ term: value.power[0] }), recurse({ term: value.power[1] }));
      }
      if ('minimum' in value) {
        return Math.min(...value.minimum.map(term => recurse({ term })));
      }
      if ('maximum' in value) {
        return Math.max(...value.maximum.map(term => recurse({ term })));
      }
      if ('sqrt' in value) {
        return Math.sqrt(recurse({ term: value.sqrt }));
      }
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    })();
    if (result === undefined || !Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
      throw new Error('Missing, non-finite or oversized model graph expression');
    }
    return result;
  };
  const condition = ({ value, depth }: { value: GraphCondition; depth: number }): boolean => {
    tick({ depth });
    if ('compare' in value) {
      const left = evaluate({ value: value.left, depth: depth + 1 }), right = evaluate({ value: value.right, depth: depth + 1 });
      switch (value.compare) {
      case 'equal': return left === right;
      case 'notEqual': return left !== right;
      case 'less': return left < right;
      case 'lessEqual': return left <= right;
      case 'greater': return left > right;
      case 'greaterEqual': return left >= right;
      default: {
        const exhaustive: never = value.compare;
        throw new Error(String(exhaustive));
      }
      }
    }
    if ('metadata' in value) {
      const { equals, ...reference } = value;
      const found = metadataValue({ reference, depth });
      if (reference.index !== undefined && (typeof found !== typeof equals || (typeof found === 'number' && !Number.isFinite(found)))) {
        // An invalid per-layer flag must not silently select the other branch
        // (for example, turn every attention layer into a non-RoPE layer).
        throw new Error(`Metadata array condition expects ${typeof equals}: ${reference.metadata} (received ${typeof found})`);
      }
      return found === equals;
    }
    if ('all' in value) {
      return value.all.every(item => condition({ value: item, depth: depth + 1 }));
    }
    if ('any' in value) {
      return value.any.some(item => condition({ value: item, depth: depth + 1 }));
    }
    if ('not' in value) {
      return !condition({ value: value.not, depth: depth + 1 });
    }
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  };
  return {
    number({ value }: { value: GraphNumber }): number {
      return evaluate({ value, depth: 0 });
    },
    condition({ value }: { value: GraphCondition }): boolean {
      return condition({ value, depth: 0 });
    },
    get steps(): number {
      return steps;
    },
  };
}

export function formatGraphName({ text, variables }: { text: string; variables: ReadonlyMap<string, number> }): string {
  // Exactly ${identifier}, ${identifier+integer}, ${identifier-integer}; never eval.
  const result = text.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)([+-]\d+)?\}/g, (_match, name: string, offset: string | undefined) => {
    const value = variables.get(name);
    const resolved = value === undefined ? undefined : value + (offset === undefined ? 0 : Number(offset));
    if (resolved === undefined || !Number.isSafeInteger(resolved)) {
      throw new Error(`Unknown or unsafe declaration variable: ${name}`);
    }
    return String(resolved);
  });
  if (result.includes('${') || result.length > 256) {
    throw new Error('Invalid model graph name template');
  }
  return result;
}

export const TEST_ONLY = {
};
