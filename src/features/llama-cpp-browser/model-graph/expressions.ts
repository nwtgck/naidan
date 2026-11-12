import { z } from 'zod';

export const graphNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.${}+-]{0,191}$/);
export type GraphMetadataValue = string | number | boolean | readonly (string | number | boolean)[];
export type GraphNumber = number
  | { parameter: string } | { variable: string }
  | { metadata: string; index?: GraphNumber }
  | { tensor: string; dimension: number }
  | { inputTokens: true } | { cacheTokens: true } | { capacity: true }
  | { sum: GraphNumber[] } | { product: GraphNumber[] }
  | { subtract: [GraphNumber, GraphNumber] } | { quotient: [GraphNumber, GraphNumber] }
  | { modulo: [GraphNumber, GraphNumber] } | { power: [GraphNumber, GraphNumber] }
  | { minimum: GraphNumber[] } | { maximum: GraphNumber[] } | { sqrt: GraphNumber };
export const graphNumberSchema: z.ZodType<GraphNumber> = z.lazy(() => z.union([
  z.number().finite(),
  z.strictObject({ parameter: graphNameSchema }), z.strictObject({ variable: graphNameSchema }),
  z.strictObject({ metadata: z.string().min(1).max(256), index: graphNumberSchema.optional() }),
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
]));
export type GraphCondition =
  | { compare: 'equal' | 'notEqual' | 'less' | 'lessEqual' | 'greater' | 'greaterEqual'; left: GraphNumber; right: GraphNumber }
  | { metadata: string; index?: GraphNumber; equals: string | number | boolean }
  | { all: GraphCondition[] } | { any: GraphCondition[] } | { not: GraphCondition };
export const graphConditionSchema: z.ZodType<GraphCondition> = z.lazy(() => z.union([
  z.strictObject({ compare: z.enum(['equal', 'notEqual', 'less', 'lessEqual', 'greater', 'greaterEqual']), left: graphNumberSchema, right: graphNumberSchema }),
  z.strictObject({ metadata: z.string().min(1).max(256), index: graphNumberSchema.optional(), equals: z.union([z.string(), z.number().finite(), z.boolean()]) }),
  z.strictObject({ all: z.array(graphConditionSchema).min(1).max(16) }),
  z.strictObject({ any: z.array(graphConditionSchema).min(1).max(16) }),
  z.strictObject({ not: graphConditionSchema }),
]));
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
  const metadataValue = ({ key, index, depth }: { key: string; index: GraphNumber | undefined; depth: number }): GraphMetadataValue | undefined => {
    const value = environment.metadata.get(key);
    if (index === undefined) {
      return value;
    }
    const offset = evaluate({ value: index, depth: depth + 1 });
    if (!Array.isArray(value) || !Number.isSafeInteger(offset) || offset < 0 || offset >= value.length) {
      throw new Error(`Metadata array index is outside its declared array: ${key}`);
    }
    return value[offset];
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
        const found = metadataValue({ key: value.metadata, index: value.index, depth });
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
      return metadataValue({ key: value.metadata, index: value.index, depth }) === value.equals;
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
