import { expandedModelGraphDefinitionSchema, validateModelGraphReferences, modelGraphDefinitionSchema, type ModelGraphDefinition, type ExpandedModelGraphDefinition, type GraphScopeBody, type GraphReference, type ModelGraphNode } from './definition';
import { validateModelGraphScopes } from './scope-validation';
import { createGraphExpressionEvaluator, type GraphMetadataValue, type GraphNameExpression } from './expressions';
import { resolveGraphReference, bindModelGraphNodeReferences, type GraphScope, type GraphSymbol } from './scope';

export type GraphBindingInventory = {
  metadata: ReadonlyMap<string, GraphMetadataValue>;
  tensors: ReadonlyMap<string, { shape: readonly number[] }>;
};

/** Lexical, bounded preparation. Captures are explicit, loop carries are edges,
 * and external names are constructed only by the closed name-expression grammar.
 * No template scanner, callbacks, or iteration remains in the native graph. */
export function expandModelGraphDefinition({ definition: source, inventory }: { definition: ModelGraphDefinition; inventory: GraphBindingInventory }): ExpandedModelGraphDefinition {
  // Typed callers and stored objects pass the same boundary as pasted JSON.
  const definition = modelGraphDefinitionSchema.parse(source);
  validateModelGraphScopes({ definition });
  let visits = 0, expressions = 0, expandedItems = 0, serial = 0;
  const parameters = new Map<string, number>();
  const evaluate = <T>({ iterations, run }: { iterations: ReadonlyMap<string, number>; run: ({ evaluator }: { evaluator: ReturnType<typeof createGraphExpressionEvaluator> }) => T }): T => {
    const evaluator = createGraphExpressionEvaluator({ environment: { parameters, iterations, metadata: inventory.metadata, tensors: inventory.tensors, inputTokens: undefined, cacheTokens: undefined, capacity: undefined }, maximumSteps: 200000 - expressions });
    try {
      return run({ evaluator });
    } finally {
      expressions += evaluator.steps;
    }
  };
  for (const parameter of definition.parameters) {
    if (parameters.has(parameter.name)) {
      throw new Error('Duplicate parameter identifier');
    }
    parameters.set(parameter.name, evaluate({ iterations: new Map(), run: ({ evaluator }) => evaluator.number({ value: parameter.value }) }));
  }
  const weights: ExpandedModelGraphDefinition['weights'] = [], slots: ExpandedModelGraphDefinition['state']['slots'] = [], tensors: ExpandedModelGraphDefinition['state']['tensors'] = [], updates: ExpandedModelGraphDefinition['state']['updates'] = [], nodes: ModelGraphNode[] = [];
  const reserved = new Set([...definition.weights, ...definition.state.slots, ...definition.state.tensors, ...definition.graph.nodes].map(value => value.id));
  const budget = (): void => {
    if (++expandedItems > 32768 || weights.length > 8192 || slots.length + tensors.length > 256 || updates.length > 256 || nodes.length > 16384) {
      throw new Error('Expanded model graph operation or persistent tensor budget exceeded');
    }
  };
  const identity = ({ local, mode }: { local: string; mode: 'root' | 'nested' }): string => {
    switch (mode) {
    case 'root': return local;
    case 'nested': {
      let id: string;
      do {
        id = `scope${++serial}.${local.slice(0, 96)}`;
      } while (reserved.has(id));
      reserved.add(id);
      return id;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
  };
  // Walk schema-validated data, resolving structural expression objects only.
  // Plain strings (including literal ${...} in GGUF names/notes) are untouched.
  const bind = ({ value, iterations, depth }: { value: unknown; iterations: ReadonlyMap<string, number>; depth: number }): unknown => {
    if (++visits > 2000000 || depth > 48) {
      throw new Error('Model graph expansion budget exceeded');
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => bind({ value: item, iterations, depth: depth + 1 }));
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Unexpected model graph declaration data');
    }
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.iteration === 'string') {
      const result = iterations.get(object.iteration);
      if (result === undefined) {
        throw new Error(`Unknown iteration binding: ${object.iteration}`);
      }
      return result;
    }
    if (Object.keys(object).length === 1 && ('concat' in object || 'decimal' in object)) {
      return evaluate({ iterations, run: ({ evaluator }) => evaluator.name({ value: value as GraphNameExpression }) });
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, bind({ value: item, iterations, depth: depth + 1 })]));
  };
  const scope = ({ captures, carried }: { captures: ReadonlyMap<string, GraphSymbol>; carried: ReadonlyMap<string, GraphSymbol> }): GraphScope => ({ locals: new Map(), captures, carried, outputs: new Map() });
  const resolve = ({ reference, environment, kind }: { reference: GraphReference; environment: GraphScope; kind: GraphSymbol['kind'] | undefined }) => resolveGraphReference({ reference, scope: environment, kind });
  const ports = ({ values, environment }: { values: Record<string, GraphReference>; environment: GraphScope }) => new Map(Object.entries(values).map(([name, reference]) => [name, resolve({ reference, environment, kind: 'tensor' })]));
  const captures = ({ values, environment }: { values: Record<string, GraphReference>; environment: GraphScope }) => new Map(Object.entries(values).map(([name, reference]) => [name, resolve({ reference, environment, kind: undefined })]));
  const append = ({ body, environment, iterations, mode, depth }: { body: GraphScopeBody; environment: GraphScope; iterations: ReadonlyMap<string, number>; mode: 'root' | 'nested'; depth: number }): void => {
    if (depth > 16) {
      throw new Error('Model graph declaration nesting exceeds 16');
    }
    const declare = ({ local, kind }: { local: string; kind: GraphSymbol['kind'] }) => {
      const id = identity({ local, mode });
      environment.locals.set(local, { kind, id });
      return id;
    };
    for (const weight of body.weights) {
      budget();
      const id = declare({ local: weight.id, kind: 'tensor' });
      weights.push({ ...weight, id, tensor: evaluate({ iterations, run: ({ evaluator }) => evaluator.name({ value: weight.tensor }) }), shape: bind({ value: weight.shape, iterations, depth: 0 }) as typeof weight.shape });
    }
    for (const slot of body.slots) {
      budget();
      const id = declare({ local: slot.id, kind: 'state' });
      slots.push({ ...slot, id, headSize: bind({ value: slot.headSize, iterations, depth: 0 }) as typeof slot.headSize, heads: bind({ value: slot.heads, iterations, depth: 0 }) as typeof slot.heads });
    }
    for (const tensor of body.tensors) {
      budget();
      const id = declare({ local: tensor.id, kind: 'state' });
      tensors.push({ ...tensor, id, shape: bind({ value: tensor.shape, iterations, depth: 0 }) as typeof tensor.shape });
    }
    for (const entry of body.nodes) {
      budget();
      switch (entry.op) {
      case 'repeat': {
        const count = evaluate({ iterations, run: ({ evaluator }) => evaluator.number({ value: entry.count }) });
        if (!Number.isSafeInteger(count) || count < 0 || count > 16384) {
          throw new Error('Repeat count must be an integer in [0, 16384]');
        }
        const captured = captures({ values: entry.capture, environment });
        let carried = new Map(Object.entries(entry.carry).map(([name, value]) => [name, resolve({ reference: value.initial, environment, kind: 'tensor' })]));
        let child = scope({ captures: captured, carried });
        for (let index = 0; index < count; index++) {
          budget();
          child = scope({ captures: captured, carried });
          const local = new Map(iterations);
          local.set(entry.index, index);
          append({ body: entry.body, environment: child, iterations: local, mode: 'nested', depth: depth + 1 });
          // Resolve ALL updates against the previous carried map, then publish
          // together. Carry is graph connectivity, not persistent mutable state.
          carried = new Map(Object.entries(entry.carry).map(([name, value]) => [name, resolve({ reference: value.next, environment: child, kind: 'tensor' })]));
        }
        child.carried = carried;
        // With zero iterations only initial carries/captures are available.
        environment.outputs.set(entry.id, ports({ values: entry.outputs, environment: child }));
        break;
      }
      case 'choose': {
        const condition = evaluate({ iterations, run: ({ evaluator }) => evaluator.condition({ value: entry.condition }) });
        const selected = condition ? entry.then : entry.otherwise;
        const child = scope({ captures: captures({ values: entry.capture, environment }), carried: new Map() });
        append({ body: selected, environment: child, iterations, mode: 'nested', depth: depth + 1 });
        environment.outputs.set(entry.id, ports({ values: selected.outputs, environment: child }));
        break;
      }
      case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': case 'permute': case 'rotaryEmbedding': case 'attentionCached': case 'tensor': case 'stateRead': case 'input': {
        const linked = bindModelGraphNodeReferences({ node: entry, resolve: ({ reference, kind }) => resolve({ reference, environment, kind }).id });
        const id = declare({ local: entry.id, kind: 'tensor' });
        // All shape/attribute expressions were schema checked. Re-parse the
        // final flat object below rather than trusting this internal narrowing.
        nodes.push({ ...bind({ value: linked, iterations, depth: 0 }) as ModelGraphNode, id });
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
    }
    for (const update of body.updates) {
      budget();
      updates.push({ slot: resolve({ reference: update.slot, environment, kind: 'state' }).id, value: resolve({ reference: update.value, environment, kind: 'tensor' }).id });
    }
  };
  const root = scope({ captures: new Map(), carried: new Map() });
  append({ body: { weights: definition.weights, slots: definition.state.slots, tensors: definition.state.tensors, updates: definition.state.updates, nodes: definition.graph.nodes }, environment: root, iterations: new Map(), mode: 'root', depth: 0 });
  budget();
  const result = expandedModelGraphDefinitionSchema.parse({ ...definition, parameters: [...parameters].map(([name, value]) => ({ name, value })), weights, state: { ...definition.state, slots, tensors, updates }, graph: { nodes }, outputs: { logits: resolve({ reference: definition.outputs.logits, environment: root, kind: 'tensor' }).id } });
  validateModelGraphReferences({ definition: result });
  return result;
}

export const TEST_ONLY = {
};
