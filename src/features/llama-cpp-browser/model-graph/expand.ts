import { expandedModelGraphDefinitionSchema, validateModelGraphReferences, type ModelGraphDefinition, type ExpandedModelGraphDefinition, type ModelGraphEntry } from './definition';
import { createGraphExpressionEvaluator, formatGraphName, type GraphMetadataValue, graphNumberSchema, graphConditionSchema } from './expressions';

export type GraphBindingInventory = {
  metadata: ReadonlyMap<string, GraphMetadataValue>;
  tensors: ReadonlyMap<string, { shape: readonly number[] }>;
};

/** Expansion is a finite compile-time transform. No loop survives into the
 * token loop and no condition can execute JavaScript or call a native function.
 * Both branches are schema-checked before the model-specific branch is chosen. */
export function expandModelGraphDefinition({ definition, inventory }: { definition: ModelGraphDefinition; inventory: GraphBindingInventory }): ExpandedModelGraphDefinition {
  let visits = 0, expressions = 0, expandedItems = 0;
  const parameters = new Map<string, number>();
  const numbers = ({ variables }: { variables: ReadonlyMap<string, number> }) => createGraphExpressionEvaluator({
    environment: { parameters, variables, metadata: inventory.metadata, tensors: inventory.tensors, inputTokens: undefined, cacheTokens: undefined, capacity: undefined },
    maximumSteps: 200000 - expressions,
  });
  for (const parameter of definition.parameters) {
    if (parameters.has(parameter.name) || !/^[A-Za-z][A-Za-z0-9_.-]{0,191}$/.test(parameter.name)) {
      throw new Error('Duplicate or invalid parameter identifier');
    }
    const evaluator = numbers({ variables: new Map() });
    parameters.set(parameter.name, evaluator.number({ value: parameter.value }));
    expressions += evaluator.steps;
  }
  const weights = [...definition.weights], slots = [...definition.state.slots], tensors = [...definition.state.tensors], updates = [...definition.state.updates];
  const nodes: ExpandedModelGraphDefinition['graph']['nodes'] = [];
  const replace = ({ value, variables, depth }: { value: unknown; variables: ReadonlyMap<string, number>; depth: number }): unknown => {
    if (++visits > 2000000 || depth > 48) {
      throw new Error('Model graph expansion budget exceeded');
    }
    if (typeof value === 'string') {
      return formatGraphName({ text: value, variables: new Map([...parameters, ...variables]) });
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => replace({ value: item, variables, depth: depth + 1 }));
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Unexpected value in model graph expansion');
    }
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.variable === 'string') {
      const result = variables.get(object.variable);
      if (result === undefined) {
        throw new Error(`Unbound declaration variable: ${object.variable}`);
      }
      return result;
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, replace({ value: item, variables, depth: depth + 1 })]));
  };
  const append = ({ items, variables, depth }: { items: readonly ModelGraphEntry[]; variables: ReadonlyMap<string, number>; depth: number }): void => {
    if (depth > 16) {
      throw new Error('Model graph declaration nesting exceeds 16');
    }
    for (const item of items) {
      if (++expandedItems > 32768) {
        throw new Error('Expanded model graph operation budget exceeded');
      }
      switch (item.op) {
      case 'repeat': {
        if (variables.has(item.index) || parameters.has(item.index)) {
          throw new Error('Repeat variables must not shadow active bindings');
        }
        if (!definition.requiredCapabilities.includes('declaration-expansion/v1')) {
          throw new Error('Missing required capability: declaration-expansion/v1');
        }
        const evaluator = numbers({ variables });
        const count = evaluator.number({ value: graphNumberSchema.parse(replace({ value: item.count, variables, depth: 0 })) });
        expressions += evaluator.steps;
        if (!Number.isSafeInteger(count) || count < 0 || count > 16384) {
          throw new Error('Repeat count must be an integer in [0, 16384]');
        }
        for (let index = 0; index < count; index++) {
          if (++expandedItems > 32768) {
            throw new Error('Expanded model graph repetition budget exceeded');
          }
          const local = new Map(variables);
          local.set(item.index, index);
          const child = ({ value }: { value: unknown }) => replace({ value, variables: local, depth: 0 });
          // Only schema-validated declarations enter this routine. The complete
          // expanded object is parsed again before it leaves the compiler.
          weights.push(...item.weights.map(value => child({ value }) as typeof value));
          slots.push(...item.slots.map(value => child({ value }) as typeof value));
          tensors.push(...item.tensors.map(value => child({ value }) as typeof value));
          updates.push(...item.updates.map(value => child({ value }) as typeof value));
          if (weights.length > 8192 || slots.length + tensors.length > 256 || updates.length > 256) {
            throw new Error('Expanded persistent tensor budget exceeded');
          }
          append({ items: item.nodes, variables: local, depth: depth + 1 });
        }
        break;
      }
      case 'choose': {
        if (!definition.requiredCapabilities.includes('declaration-expansion/v1')) {
          throw new Error('Missing required capability: declaration-expansion/v1');
        }
        const evaluator = numbers({ variables });
        const condition = evaluator.condition({ value: graphConditionSchema.parse(replace({ value: item.condition, variables, depth: 0 })) });
        expressions += evaluator.steps;
        append({ items: condition ? item.then : item.otherwise, variables, depth: depth + 1 });
        break;
      }
      case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu':
      case 'contiguous': case 'scale': case 'reshape': case 'permute': case 'rotaryEmbedding': case 'attentionCached': case 'tensor': case 'stateRead': case 'input':
        nodes.push(replace({ value: item, variables, depth: 0 }) as typeof item);
        break;
      default: {
        const exhaustive: never = item;
        throw new Error(String(exhaustive));
      }
      }
    }
  };
  const empty = new Map<string, number>();
  append({ items: definition.graph.nodes, variables: empty, depth: 0 });
  const result = expandedModelGraphDefinitionSchema.parse({
    ...definition,
    parameters: [...parameters].map(([name, value]) => ({ name, value })),
    weights: replace({ value: weights, variables: empty, depth: 0 }),
    state: { ...definition.state, slots: replace({ value: slots, variables: empty, depth: 0 }), tensors: replace({ value: tensors, variables: empty, depth: 0 }), updates: replace({ value: updates, variables: empty, depth: 0 }) },
    outputs: replace({ value: definition.outputs, variables: empty, depth: 0 }),
    graph: { nodes },
  });
  validateModelGraphReferences({ definition: result });
  return result;
}

export const TEST_ONLY = {
};
