import type { GraphReference, GraphScopeBody, ModelGraphDefinition } from './definition';
import { resolveGraphReference, bindModelGraphNodeReferences, type GraphSymbol, type GraphScope } from './scope';

/** Pure lexical validation visits both branches and zero-count bodies. Only
 * model-dependent arithmetic is deferred; a hidden branch cannot escape scope. */
export function validateModelGraphScopes({ definition }: { definition: ModelGraphDefinition }): void {
  let visits = 0;
  const parameters = new Set(definition.parameters.map(parameter => parameter.name));
  if (parameters.size !== definition.parameters.length) {
    throw new Error('Duplicate parameter');
  }
  const tick = ({ depth }: { depth: number }) => {
    if (++visits > 2000000 || depth > 48) {
      throw new Error('Model graph scope validation budget exceeded');
    }
  };
  const expressions = ({ value, iterations, depth }: { value: unknown; iterations: ReadonlySet<string>; depth: number }): void => {
    tick({ depth });
    if (Array.isArray(value)) {
      for (const item of value) {
        expressions({ value: item, iterations, depth: depth + 1 });
      }
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Object.hasOwn(record, 'iteration') && (typeof record.iteration !== 'string' || !iterations.has(record.iteration))) {
        throw new Error(`Unknown iteration binding: ${String(record.iteration)}`);
      }
      if (Object.hasOwn(record, 'parameter') && (typeof record.parameter !== 'string' || !parameters.has(record.parameter))) {
        throw new Error(`Unknown parameter: ${String(record.parameter)}`);
      }
      for (const item of Object.values(record)) {
        expressions({ value: item, iterations, depth: depth + 1 });
      }
    }
  };
  for (const parameter of definition.parameters) {
    expressions({ value: parameter.value, iterations: new Set(), depth: 0 });
  }
  const scope = ({ captures, carried }: { captures: ReadonlyMap<string, GraphSymbol>; carried: ReadonlyMap<string, GraphSymbol> }): GraphScope => ({ locals: new Map(), captures, carried, outputs: new Map() });
  const resolve = ({ reference, environment, kind }: { reference: GraphReference; environment: GraphScope; kind: GraphSymbol['kind'] | undefined }) => resolveGraphReference({ reference, scope: environment, kind });
  const ports = ({ values, environment }: { values: Record<string, GraphReference>; environment: GraphScope }) => new Map(Object.entries(values).map(([name, reference]) => [name, resolve({ reference, environment, kind: 'tensor' })]));
  const captures = ({ values, environment }: { values: Record<string, GraphReference>; environment: GraphScope }) => new Map(Object.entries(values).map(([name, reference]) => [name, resolve({ reference, environment, kind: undefined })]));
  const visit = ({ body, environment, iterations, depth }: { body: GraphScopeBody; environment: GraphScope; iterations: ReadonlySet<string>; depth: number }): void => {
    tick({ depth });
    if (depth > 16) {
      throw new Error('Model graph declaration nesting exceeds 16');
    }
    const names = new Set<string>();
    const register = ({ name, kind }: { name: string; kind: GraphSymbol['kind'] }) => {
      if (names.has(name)) {
        throw new Error(`Duplicate local graph identifier: ${name}`);
      }
      names.add(name);
      environment.locals.set(name, { kind, id: name });
    };
    for (const weight of body.weights) {
      expressions({ value: weight, iterations, depth: 0 });
      register({ name: weight.id, kind: 'tensor' });
    }
    for (const slot of [...body.slots, ...body.tensors]) {
      expressions({ value: slot, iterations, depth: 0 });
      register({ name: slot.id, kind: 'state' });
    }
    for (const entry of body.nodes) {
      tick({ depth });
      if (names.has(entry.id)) {
        throw new Error(`Duplicate local graph identifier: ${entry.id}`);
      }
      switch (entry.op) {
      case 'repeat': {
        if (!definition.requiredCapabilities.includes('scoped-declarations/v1')) {
          throw new Error('Missing required capability: scoped-declarations/v1');
        }
        if (iterations.has(entry.index) || parameters.has(entry.index)) {
          throw new Error('Repeat bindings must not shadow an active iteration or parameter');
        }
        expressions({ value: entry.count, iterations, depth: 0 });
        const carried = new Map(Object.entries(entry.carry).map(([name, value]) => [name, resolve({ reference: value.initial, environment, kind: 'tensor' })]));
        const child = scope({ captures: captures({ values: entry.capture, environment }), carried });
        visit({ body: entry.body, environment: child, iterations: new Set([...iterations, entry.index]), depth: depth + 1 });
        for (const value of Object.values(entry.carry)) {
          resolve({ reference: value.next, environment: child, kind: 'tensor' });
        }
        environment.outputs.set(entry.id, ports({ values: entry.outputs, environment: child }));
        names.add(entry.id);
        break;
      }
      case 'choose': {
        if (!definition.requiredCapabilities.includes('scoped-declarations/v1')) {
          throw new Error('Missing required capability: scoped-declarations/v1');
        }
        expressions({ value: entry.condition, iterations, depth: 0 });
        const captured = captures({ values: entry.capture, environment });
        const left = scope({ captures: captured, carried: new Map() }), right = scope({ captures: captured, carried: new Map() });
        visit({ body: entry.then, environment: left, iterations, depth: depth + 1 });
        visit({ body: entry.otherwise, environment: right, iterations, depth: depth + 1 });
        const leftPorts = ports({ values: entry.then.outputs, environment: left }), rightPorts = ports({ values: entry.otherwise.outputs, environment: right });
        if (leftPorts.size !== rightPorts.size || [...leftPorts.keys()].some(name => !rightPorts.has(name))) {
          throw new Error('Both choose branches must expose exactly the same output ports');
        }
        environment.outputs.set(entry.id, leftPorts);
        names.add(entry.id);
        break;
      }
      case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': case 'permute': case 'rotaryEmbedding': case 'attentionCached': case 'tensor': case 'stateRead': case 'input':
        expressions({ value: entry, iterations, depth: 0 });
        bindModelGraphNodeReferences({ node: entry, resolve: ({ reference, kind }) => resolve({ reference, environment, kind }).id });
        register({ name: entry.id, kind: 'tensor' });
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
    }
    for (const update of body.updates) {
      resolve({ reference: update.slot, environment, kind: 'state' });
      resolve({ reference: update.value, environment, kind: 'tensor' });
    }
  };
  const root = scope({ captures: new Map(), carried: new Map() });
  visit({ body: { weights: definition.weights, ...definition.state, nodes: definition.graph.nodes }, environment: root, iterations: new Set(), depth: 0 });
  resolve({ reference: definition.outputs.logits, environment: root, kind: 'tensor' });
}

export const TEST_ONLY = {
};
