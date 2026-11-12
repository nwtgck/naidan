import type { GraphReference, DeclaredModelGraphNode, ModelGraphNode } from './definition';

export type GraphSymbol = { kind: 'tensor' | 'state'; id: string };
export type GraphScope = {
  locals: Map<string, GraphSymbol>;
  captures: ReadonlyMap<string, GraphSymbol>;
  carried: ReadonlyMap<string, GraphSymbol>;
  outputs: Map<string, ReadonlyMap<string, GraphSymbol>>;
};

export function resolveGraphReference({ reference, scope, kind }: { reference: GraphReference; scope: GraphScope; kind: GraphSymbol['kind'] | undefined }): GraphSymbol {
  const value = (() => {
    if (typeof reference === 'string') {
      return scope.locals.get(reference);
    }
    if ('local' in reference) {
      return scope.locals.get(reference.local);
    }
    if ('capture' in reference) {
      return scope.captures.get(reference.capture);
    }
    if ('carry' in reference) {
      return scope.carried.get(reference.carry);
    }
    if ('output' in reference) {
      return scope.outputs.get(reference.output.block)?.get(reference.output.port);
    }
    const exhaustive: never = reference;
    throw new Error(String(exhaustive));
  })();
  if (!value) {
    throw new Error(`Unknown, forward or out-of-scope graph reference: ${JSON.stringify(reference)}`);
  }
  if (kind !== undefined && value.kind !== kind) {
    throw new Error(`Expected ${kind} reference: ${JSON.stringify(reference)}`);
  }
  return value;
}

export function bindModelGraphNodeReferences({ node, resolve }: { node: DeclaredModelGraphNode; resolve: ({ reference, kind }: { reference: GraphReference; kind: GraphSymbol['kind'] }) => string }): ModelGraphNode {
  const tensor = ({ reference }: { reference: GraphReference }) => resolve({ reference, kind: 'tensor' });
  const state = ({ reference }: { reference: GraphReference }) => resolve({ reference, kind: 'state' });
  switch (node.op) {
  case 'embedding': return { ...node, weight: tensor({ reference: node.weight }) };
  case 'linear': return { ...node, weight: tensor({ reference: node.weight }), input: tensor({ reference: node.input }) };
  case 'tensor': return { ...node, inputs: node.inputs.map(reference => tensor({ reference })) };
  case 'stateRead': return { ...node, slot: state({ reference: node.slot }) };
  case 'input': return node;
  case 'add': case 'subtract': case 'multiply': return { ...node, left: tensor({ reference: node.left }), right: tensor({ reference: node.right }) };
  case 'normalizeRms': case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': case 'permute': return { ...node, input: tensor({ reference: node.input }) };
  case 'rotaryEmbedding': return { ...node, input: tensor({ reference: node.input }), frequencyFactors: node.frequencyFactors === undefined ? undefined : tensor({ reference: node.frequencyFactors }) };
  case 'attentionCached': return { ...node, query: tensor({ reference: node.query }), key: tensor({ reference: node.key }), value: tensor({ reference: node.value }), slot: state({ reference: node.slot }) };
  default: {
    const exhaustive: never = node;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
