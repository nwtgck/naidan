import { z } from 'zod';
import { parseConcatenatedJson } from '@/utils/json-stream-parser';
import { graphNameSchema, graphNumberSchema, graphConditionSchema, type GraphNumber, type GraphCondition } from './expressions';
import { graphWeightTypeSchema } from './tensor-layout';
import { tensorOperatorNodeSchema } from './operators';

// Deliberately incompatible experimental data language. No persisted user has
// adopted this prototype; old sources remain copyable, never auto-reinterpreted.
export const modelGraphFormat = 'naidan.model-graph/experimental-2';
export const modelGraphCapabilities = ['tensor-graph/v1', 'decoder-kv-linear/v1', 'rotary-normal-neox/v1', 'tensor-operators/v2', 'persistent-state/v1', 'declaration-expansion/v1', 'decoder-inputs/v1'] as const;
const nameSchema = graphNameSchema;
const scalarSchema = graphNumberSchema;
const dimensionSchema = graphNumberSchema;
export type Dimension = GraphNumber;
const inputSchema = nameSchema;
const unary = { id: nameSchema, input: inputSchema };
const binary = { id: nameSchema, left: inputSchema, right: inputSchema };
export const modelGraphNodeSchema = z.discriminatedUnion('op', [
  z.strictObject({ id: nameSchema, op: z.literal('embedding'), weight: nameSchema }),
  z.strictObject({ id: nameSchema, op: z.literal('linear'), weight: nameSchema, input: inputSchema }),
  z.strictObject({ ...unary, op: z.literal('normalizeRms'), epsilon: scalarSchema }),
  z.strictObject({ ...binary, op: z.literal('add') }),
  z.strictObject({ ...binary, op: z.literal('subtract') }),
  z.strictObject({ ...binary, op: z.literal('multiply') }),
  z.strictObject({ ...unary, op: z.literal('sigmoid') }),
  z.strictObject({ ...unary, op: z.literal('silu') }),
  z.strictObject({ ...unary, op: z.literal('contiguous') }),
  z.strictObject({ ...unary, op: z.literal('scale'), value: scalarSchema }),
  z.strictObject({ ...unary, op: z.literal('reshape'), shape: z.array(dimensionSchema).min(1).max(4) }),
  z.strictObject({ ...unary, op: z.literal('permute'), axes: z.tuple([z.number().int().min(0).max(3), z.number().int().min(0).max(3), z.number().int().min(0).max(3), z.number().int().min(0).max(3)]) }),
  z.strictObject({
    ...unary,
    op: z.literal('rotaryEmbedding'),
    dimensions: dimensionSchema,
    mode: z.enum(['normal', 'neox']),
    frequencyBase: scalarSchema,
    frequencyScale: scalarSchema,
    scaling: z.strictObject({ contextOriginal: scalarSchema, extensionFactor: scalarSchema, attentionFactor: scalarSchema, betaFast: scalarSchema, betaSlow: scalarSchema }).optional(),
    frequencyFactors: nameSchema.optional(),
  }),
  tensorOperatorNodeSchema,
  z.strictObject({ id: nameSchema, op: z.literal('stateRead'), slot: nameSchema }),
  z.strictObject({ id: nameSchema, op: z.literal('input'), source: z.enum(['tokenIds', 'positions', 'positionsF32']) }),
  z.strictObject({ id: nameSchema, op: z.literal('attentionCached'), query: inputSchema, key: inputSchema, value: inputSchema, slot: nameSchema, window: z.number().int().nonnegative().max(131072), scale: z.union([z.literal('inverseSqrtHead'), scalarSchema]) }),
]);
export type ModelGraphNode = z.infer<typeof modelGraphNodeSchema>;
const weightSchema = z.strictObject({ id: nameSchema, tensor: z.string().min(1).max(256), shape: z.array(dimensionSchema).min(1).max(4), types: z.array(graphWeightTypeSchema).min(1).max(32) });
const cacheSlotSchema = z.strictObject({ id: nameSchema, headSize: dimensionSchema, heads: dimensionSchema, precision: z.enum(['F16', 'F32']) });
const stateTensorSchema = z.strictObject({ id: nameSchema, shape: z.array(dimensionSchema).min(1).max(4), precision: z.enum(['F32', 'F16', 'BF16']), initial: z.literal('zeros') });
const updateSchema = z.strictObject({ slot: nameSchema, value: nameSchema });
export type ModelGraphWeight = z.infer<typeof weightSchema>;
export type ModelGraphCacheSlot = z.infer<typeof cacheSlotSchema>;
export type ModelGraphStateTensor = z.infer<typeof stateTensorSchema>;
export type ModelGraphStateUpdate = z.infer<typeof updateSchema>;
export type ModelGraphEntry = ModelGraphNode
  | { id: string; op: 'repeat'; index: string; count: GraphNumber; weights: ModelGraphWeight[]; slots: ModelGraphCacheSlot[]; tensors: ModelGraphStateTensor[]; updates: ModelGraphStateUpdate[]; nodes: ModelGraphEntry[] }
  | { id: string; op: 'choose'; condition: GraphCondition; then: ModelGraphEntry[]; otherwise: ModelGraphEntry[] };
const entrySchema: z.ZodType<ModelGraphEntry> = z.lazy(() => z.union([
  modelGraphNodeSchema,
  z.strictObject({
    id: nameSchema,
    op: z.literal('repeat'),
    index: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    count: graphNumberSchema,
    weights: z.array(weightSchema).max(8192),
    slots: z.array(cacheSlotSchema).max(256),
    tensors: z.array(stateTensorSchema).max(256),
    updates: z.array(updateSchema).max(256),
    nodes: z.array(entrySchema).max(16384),
  }),
  z.strictObject({ id: nameSchema, op: z.literal('choose'), condition: graphConditionSchema, then: z.array(entrySchema).max(16384), otherwise: z.array(entrySchema).max(16384) }),
]));
const baseShape = {
  format: z.literal(modelGraphFormat),
  name: z.string().trim().min(1).max(120),
  applicability: z.strictObject({
    architecture: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    metadata: z.array(z.strictObject({ key: z.string().min(1).max(256), value: z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.array(z.union([z.string().max(1024), z.number().finite(), z.boolean()])).max(4096)]) })).max(64),
  }),
  requiredCapabilities: z.array(z.enum(modelGraphCapabilities)).min(1).max(modelGraphCapabilities.length),
  parameters: z.array(z.strictObject({ name: nameSchema, value: scalarSchema })).max(256),
  weights: z.array(weightSchema).max(8192),
  state: z.strictObject({
    profile: z.literal('decoder-state/v2'),
    slots: z.array(cacheSlotSchema).max(256),
    tensors: z.array(stateTensorSchema).max(256),
    updates: z.array(updateSchema).max(256),
  }),
  outputs: z.strictObject({ logits: nameSchema }),
  annotations: z.string().max(4096).optional(),
};
export const modelGraphDefinitionSchema = z.strictObject({ ...baseShape, graph: z.strictObject({ nodes: z.array(entrySchema).min(1).max(16384) }) });
export const expandedModelGraphDefinitionSchema = z.strictObject({ ...baseShape, graph: z.strictObject({ nodes: z.array(modelGraphNodeSchema).min(1).max(16384) }) });
export type ModelGraphDefinition = z.infer<typeof modelGraphDefinitionSchema>;
export type ExpandedModelGraphDefinition = z.infer<typeof expandedModelGraphDefinitionSchema>;
export type ModelGraphWeightType = z.infer<typeof graphWeightTypeSchema>;
export type ModelGraphScalar = GraphNumber;

export function parseModelGraphDefinitions({ input }: { input: string }): { source: string; definition: ModelGraphDefinition }[] {
  const results = parseConcatenatedJson({ input });
  if (!results.length) {
    throw new Error('Paste at least one model graph object');
  }
  if (results.length > 32) {
    throw new Error('At most 32 model graph definitions can be imported together');
  }
  return results.map((result, index) => {
    if (!result.success) {
      throw new Error(`Object ${index + 1}: ${result.error}`);
    }
    if (new TextEncoder().encode(result.raw).byteLength > 1024 * 1024) {
      throw new Error(`Object ${index + 1}: model graph exceeds 1 MiB`);
    }
    const parsed = modelGraphDefinitionSchema.safeParse(result.data);
    if (!parsed.success) {
      const errors = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new Error(`Object ${index + 1}: ${errors}`);
    }
    // Macro branches are structurally checked now and semantically checked
    // after bounded expansion against the selected model's metadata.
    if (parsed.data.graph.nodes.every(node => node.op !== 'repeat' && node.op !== 'choose')) {
      validateModelGraphReferences({ definition: expandedModelGraphDefinitionSchema.parse(parsed.data) });
    }
    return { source: result.raw, definition: parsed.data };
  });
}

export function modelGraphNodeInputs({ node }: { node: ModelGraphNode }): string[] {
  switch (node.op) {
  case 'embedding': return [node.weight];
  case 'tensor': return node.inputs;
  case 'stateRead': case 'input': return [];
  case 'linear': return [node.weight, node.input];
  case 'add': case 'subtract': case 'multiply': return [node.left, node.right];
  case 'normalizeRms': case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': case 'permute': return [node.input];
  case 'rotaryEmbedding': return node.frequencyFactors === undefined ? [node.input] : [node.input, node.frequencyFactors];
  case 'attentionCached': return [node.query, node.key, node.value];
  default: {
    const exhaustive: never = node;
    throw new Error(String(exhaustive));
  }
  }
}

export function validateModelGraphReferences({ definition }: { definition: ExpandedModelGraphDefinition }): void {
  const unique = ({ names, kind }: { names: readonly string[], kind: string }): void => {
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate ${kind}`);
    }
  };
  unique({ names: definition.parameters.map(value => value.name), kind: 'parameter' });
  unique({ names: [...definition.state.slots, ...definition.state.tensors].map(value => value.id), kind: 'state slot' });
  unique({ names: definition.state.updates.map(value => value.slot), kind: 'state update' });
  const stateIds = new Set(definition.state.tensors.map(value => value.id));
  if (definition.state.updates.length !== stateIds.size || definition.state.updates.some(value => !stateIds.has(value.slot))) {
    throw new Error('Every persistent tensor requires exactly one declared update');
  }
  unique({ names: definition.requiredCapabilities, kind: 'capability' });
  unique({ names: definition.applicability.metadata.map(value => value.key), kind: 'metadata constraint' });
  const required = new Set<string>(['tensor-graph/v1']);
  if (definition.state.tensors.length) {
    required.add('persistent-state/v1');
  }
  const slots = new Set(definition.state.slots.map(value => value.id));
  const written = new Set<string>();
  const ids = new Set<string>();
  const weights = new Set<string>();
  for (const weight of definition.weights) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,191}$/.test(weight.id)) {
      throw new Error('Unexpanded tensor identifier');
    }
    if (ids.has(weight.id)) {
      throw new Error(`Duplicate tensor: ${weight.id}`);
    }
    ids.add(weight.id);
    weights.add(weight.id);
  }
  const ancestors = new Map<string, string[]>();
  for (const node of definition.graph.nodes) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,191}$/.test(node.id)) {
      throw new Error('Unexpanded operation identifier');
    }
    if (ids.has(node.id)) {
      throw new Error(`Duplicate tensor: ${node.id}`);
    }
    const inputs = modelGraphNodeInputs({ node });
    for (const input of inputs) {
      if (!ids.has(input)) {
        throw new Error(`Unknown or forward tensor reference: ${input}`);
      }
    }
    if ('weight' in node && !weights.has(node.weight)) {
      throw new Error(`Not a weight: ${node.weight}`);
    }
    switch (node.op) {
    case 'attentionCached': {
      required.add('decoder-kv-linear/v1');
      if (!slots.has(node.slot) || written.has(node.slot)) {
        throw new Error(`Unknown or multiply written state slot: ${node.slot}`);
      }
      written.add(node.slot);
      break;
    }
    case 'tensor': required.add('tensor-operators/v2');
      break;
    case 'input': required.add('decoder-inputs/v1');
      break;
    case 'stateRead':
      required.add('persistent-state/v1');
      if (!stateIds.has(node.slot)) {
        throw new Error(`Unknown persistent tensor: ${node.slot}`);
      }
      break;
    case 'rotaryEmbedding': required.add('rotary-normal-neox/v1');
      break;
    case 'permute': if (new Set(node.axes).size !== 4) {
      throw new Error('Permutation axes must be distinct');
    }
      break;
    case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': break;
    default: {
      const exhaustive: never = node;
      throw new Error(String(exhaustive));
    }
    }
    ids.add(node.id);
    ancestors.set(node.id, inputs);
  }
  if (!ancestors.has(definition.outputs.logits)) {
    throw new Error('Logits must reference an operation result');
  }
  for (const capability of required) {
    if (!definition.requiredCapabilities.includes(capability as typeof modelGraphCapabilities[number])) {
      throw new Error(`Missing required capability: ${capability}`);
    }
  }
  const reachable = new Set<string>();
  for (const update of definition.state.updates) {
    if (!ids.has(update.value)) {
      throw new Error(`Unknown state update value: ${update.value}`);
    }
  }
  const pending = [definition.outputs.logits, ...definition.state.updates.map(update => update.value)];
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    pending.push(...(ancestors.get(current) ?? []));
  }
  for (const node of definition.graph.nodes) {
    if (!reachable.has(node.id)) {
      throw new Error(`Unreachable operation: ${node.id}`);
    }
  }
  if (written.size !== slots.size) {
    throw new Error('Every state slot needs exactly one reachable writer');
  }
}

export const TEST_ONLY = {
};
