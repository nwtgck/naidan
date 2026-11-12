import { checkModelGraphMemoryBudget } from './memory-budget';
import type { Dimension, ModelGraphDefinition, ModelGraphNode, ModelGraphScalar, ModelGraphWeightType } from './definition';
import { expandModelGraphDefinition } from './expand';
import { createGraphExpressionEvaluator, type GraphMetadataValue } from './expressions';
import { graphTensorBytes, graphSameShape, requireGraphF32Type, type GraphTensorType, type GraphTensorLayout } from './tensor-layout';
import { bindTensorOperator, type BoundTensorOperation } from './operators';
import type { ExpandedModelGraphDefinition } from './definition';

export type ModelGraphTensorInfo = { name: string; shape: readonly number[]; type: ModelGraphWeightType; bytes: number };
export type ModelGraphInventory = { architecture: string; metadata: ReadonlyMap<string, GraphMetadataValue>; tensors: ReadonlyMap<string, ModelGraphTensorInfo>; vocabularySize: number };
type ConcreteNode = Exclude<ModelGraphNode, { op: 'normalizeRms' | 'scale' | 'reshape' | 'rotaryEmbedding' | 'attentionCached' | 'tensor' }>
  | { id: string; op: 'normalizeRms'; input: string; epsilon: number }
  | { id: string; op: 'scale'; input: string; value: number }
  | { id: string; op: 'reshape'; input: string; shape: number[] }
  | { id: string; op: 'rotaryEmbedding'; input: string; dimensions: number; mode: 'normal' | 'neox'; frequencyBase: number; frequencyScale: number; frequencyFactors: string | undefined; contextOriginal: number; extensionFactor: number; attentionFactor: number; betaFast: number; betaSlow: number }
  | { id: string; op: 'tensor'; inputs: string[]; operation: BoundTensorOperation }
  | { id: string; op: 'attentionCached'; query: string; key: string; value: string; slot: string; window: number; scale: number };
export type ModelGraphPlan = {
  definition: ExpandedModelGraphDefinition,
  tensors: { id: string; shape: number[]; precision: 'F32' | 'F16' | 'BF16' }[],
  updates: { slot: string; value: string }[],
  extraTensorCount: number,
  weights: { id: string; tensor: ModelGraphTensorInfo }[],
  slots: { id: string; headSize: number; heads: number; precision: 'F16' | 'F32' }[],
  nodes: { node: ConcreteNode; shape: number[] }[],
  logits: string,
  inputTokens: number,
  cacheTokens: number,
  capacity: number,
  vocabularySize: number,
  stateBytes: number,
  largestTensorBytes: number,
};

export function modelGraphTensorBytes({ shape, type }: { shape: readonly number[]; type: GraphTensorType }): number {
  return graphTensorBytes({ shape, type });
}

export function compileModelGraph({ definition: declaration, inventory, inputTokens, cacheTokens, capacity, maximumScratchBytes }: {
  definition: ModelGraphDefinition, inventory: ModelGraphInventory, inputTokens: number, cacheTokens: number, capacity: number, maximumScratchBytes: number,
}): ModelGraphPlan {
  const definition = expandModelGraphDefinition({ definition: declaration, inventory });
  if (![inputTokens, cacheTokens, capacity, maximumScratchBytes].every(value => Number.isSafeInteger(value) && value > 0) || inputTokens > cacheTokens || cacheTokens > capacity || capacity > 131072) {
    throw new Error('Invalid graph execution dimensions');
  }
  if (!Number.isSafeInteger(inventory.vocabularySize) || inventory.vocabularySize < 1 || inventory.vocabularySize > 1048576) {
    throw new Error('Unsupported vocabulary size');
  }
  if (definition.applicability.architecture !== inventory.architecture) {
    throw new Error('Model architecture does not match the definition');
  }
  for (const { key, value } of definition.applicability.metadata) {
    if (JSON.stringify(inventory.metadata.get(key)) !== JSON.stringify(value)) {
      throw new Error(`Model metadata does not match: ${key}`);
    }
  }
  const parameters = new Map<string, number>();
  for (const parameter of definition.parameters) {
    if (typeof parameter.value !== 'number') {
      throw new Error('Unresolved model parameter');
    }
    parameters.set(parameter.name, parameter.value);
  }
  const expression = createGraphExpressionEvaluator({
    environment: { parameters, iterations: new Map(), metadata: inventory.metadata, tensors: inventory.tensors, inputTokens, cacheTokens, capacity },
    maximumSteps: 200000,
  });
  const persistentExpression = createGraphExpressionEvaluator({
    environment: { parameters, iterations: new Map(), metadata: inventory.metadata, tensors: inventory.tensors, inputTokens: undefined, cacheTokens: undefined, capacity },
    maximumSteps: 200000,
  });
  const scalar = ({ value }: { value: ModelGraphScalar }): number => {
    const result = expression.number({ value });
    if (!Number.isFinite(Math.fround(result))) {
      throw new Error('Invalid scalar parameter');
    }
    return result;
  };
  const dimension = ({ value, allowTokens }: { value: Dimension; allowTokens: boolean }): number => {
    const result = (allowTokens ? expression : persistentExpression).number({ value });
    if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647) {
      throw new Error('Invalid or overflowing tensor dimension');
    }
    return result;
  };
  type Tensor = { shape: number[]; type: GraphTensorType; contiguous: boolean; indices: GraphTensorLayout['indices'] };
  const tensors = new Map<string, Tensor>();
  const lookup = ({ id }: { id: string }): Tensor => {
    const tensor = tensors.get(id);
    if (!tensor) {
      throw new Error(`Unknown tensor: ${id}`);
    }
    return tensor;
  };
  const f32 = ({ id }: { id: string }): Tensor => {
    const tensor = lookup({ id });
    requireGraphF32Type({ type: tensor.type });
    return tensor;
  };
  // The initial dialect requires explicit materialization after a permutation.
  // This prevents backend-specific stride assertions before capability checks.
  const activation = ({ id }: { id: string }): Tensor => {
    const tensor = f32({ id });
    if (!tensor.contiguous) {
      throw new Error(`Materialize the permuted activation with contiguous: ${id}`);
    }
    return tensor;
  };
  const sameShape = ({ left, right }: { left: readonly number[], right: readonly number[] }): boolean => graphSameShape({ left, right });
  let largestTensorBytes = 0;
  const weights = definition.weights.map(weight => {
    const tensor = inventory.tensors.get(weight.tensor);
    const shape = weight.shape.map(value => dimension({ value, allowTokens: false }));
    if (!tensor || !weight.types.includes(tensor.type) || !sameShape({ left: shape, right: tensor.shape })) {
      throw new Error(`Weight type or shape mismatch: ${weight.tensor}`);
    }
    if (modelGraphTensorBytes({ shape, type: tensor.type }) !== tensor.bytes) {
      throw new Error(`Invalid weight byte size: ${weight.tensor}`);
    }
    largestTensorBytes = Math.max(largestTensorBytes, tensor.bytes);
    tensors.set(weight.id, { shape, type: tensor.type, contiguous: true, indices: undefined });
    return { id: weight.id, tensor };
  });
  const slots = definition.state.slots.map(slot => ({ id: slot.id, headSize: dimension({ value: slot.headSize, allowTokens: false }), heads: dimension({ value: slot.heads, allowTokens: false }), precision: slot.precision }));
  const persistent = definition.state.tensors.map(tensor => ({
    id: tensor.id,
    precision: tensor.precision,
    shape: tensor.shape.map(value => dimension({ value, allowTokens: false })),
  }));
  if (persistent.length && inputTokens !== 1) {
    throw new Error('General recurrent state is evaluated one token at a time');
  }
  let stateBytes = 0n;
  for (const tensor of persistent) {
    const bytes = modelGraphTensorBytes({ shape: tensor.shape, type: tensor.precision });
    largestTensorBytes = Math.max(largestTensorBytes, bytes);
    stateBytes += BigInt(bytes);
  }
  for (const slot of slots) {
    const bytes = modelGraphTensorBytes({ shape: [slot.headSize, capacity, slot.heads], type: slot.precision });
    largestTensorBytes = Math.max(largestTensorBytes, bytes);
    stateBytes += 2n * BigInt(bytes);
  }
  checkModelGraphMemoryBudget({ phase: 'state', stateBytes, computeBytes: 0n, maximumBytes: maximumScratchBytes, contextTokens: capacity, batchTokens: inputTokens });
  let extraTensorCount = persistent.length;
  const nodes: ModelGraphPlan['nodes'] = [];
  for (const source of definition.graph.nodes) {
    let node: ConcreteNode;
    let shape: number[];
    let contiguous = true;
    let outputType: GraphTensorType = 'F32';
    let indices: GraphTensorLayout['indices'];
    switch (source.op) {
    case 'input': {
      shape = [inputTokens];
      switch (source.source) {
      case 'tokenIds': outputType = 'I32';
        indices = { minimum: 0, maximum: inventory.vocabularySize - 1 };
        break;
      case 'positions': outputType = 'I32';
        indices = { minimum: 0, maximum: capacity - 1 };
        break;
      case 'positionsF32': outputType = 'F32';
        break;
      default: {
        const exhaustive: never = source.source;
        throw new Error(String(exhaustive));
      }
      }
      node = source;
      break;
    }
    case 'tensor': {
      const operation = bindTensorOperator({
        node: source,
        inputs: source.inputs.map(id => {
          const input = lookup({ id });
          return { shape: input.shape, type: input.type, layout: input.contiguous ? 'contiguous' : 'strided', indices: input.indices };
        }),
        number: ({ value }) => expression.number({ value }),
      });
      node = { id: source.id, op: 'tensor', inputs: source.inputs, operation };
      shape = [...operation.tensor.shape];
      outputType = operation.tensor.type;
      contiguous = operation.tensor.layout === 'contiguous';
      indices = operation.tensor.indices;
      extraTensorCount += operation.extraTensorCount;
      break;
    }
    case 'stateRead': {
      const state = persistent.find(value => value.id === source.slot);
      if (!state) {
        throw new Error('Unknown persistent tensor read');
      }
      node = source;
      shape = state.shape;
      outputType = state.precision;
      break;
    }
    case 'embedding': {
      node = source;
      const weight = lookup({ id: source.weight });
      if (weight.shape.length !== 2 || weight.shape[1] !== inventory.vocabularySize) {
        throw new Error('Embedding must have a vocabulary axis');
      }
      shape = [weight.shape[0]!, inputTokens];
      break;
    }
    case 'linear': {
      node = source;
      const weight = lookup({ id: source.weight }), input = activation({ id: source.input });
      if (weight.shape.length !== 2 || input.shape.length !== 2 || weight.shape[0] !== input.shape[0]) {
        throw new Error(`Linear shape mismatch: ${source.id}`);
      }
      shape = [weight.shape[1]!, input.shape[1]!];
      break;
    }
    case 'add': case 'subtract': case 'multiply': {
      node = source;
      const left = activation({ id: source.left }), right = activation({ id: source.right });
      if (right.shape.length > left.shape.length || right.shape.some((size, index) => size !== 1 && size !== left.shape[index])) {
        throw new Error(`Unsupported broadcast: ${source.id}`);
      }
      // ggml_sub only accepts equal shapes on all backends.
      if (source.op === 'subtract' && !sameShape({ left: left.shape, right: right.shape })) {
        throw new Error('Subtract requires equal shapes');
      }
      shape = [...left.shape];
      break;
    }
    case 'normalizeRms': {
      const input = activation({ id: source.input });
      const epsilon = scalar({ value: source.epsilon });
      if (Math.fround(epsilon) <= 0 || epsilon > 1) {
        throw new Error('Invalid normalization epsilon');
      }
      node = { ...source, epsilon };
      shape = [...input.shape];
      break;
    }
    case 'contiguous': {
      node = source;
      shape = [...f32({ id: source.input }).shape];
      break;
    }
    case 'sigmoid': case 'silu': {
      node = source;
      shape = [...activation({ id: source.input }).shape];
      break;
    }
    case 'scale': {
      node = { ...source, value: scalar({ value: source.value }) };
      shape = [...activation({ id: source.input }).shape];
      break;
    }
    case 'reshape': {
      const input = activation({ id: source.input });
      shape = source.shape.map(value => dimension({ value, allowTokens: true }));
      if (!input.contiguous || modelGraphTensorBytes({ shape, type: 'F32' }) !== modelGraphTensorBytes({ shape: input.shape, type: 'F32' })) {
        throw new Error('Reshape requires equal size and contiguous input');
      }
      node = { ...source, shape };
      break;
    }
    case 'permute': {
      node = source;
      const input = f32({ id: source.input });
      shape = [1, 1, 1, 1];
      // GGML maps each input axis to the requested output axis.
      source.axes.forEach((destination, index) => {
        shape[destination] = input.shape[index] ?? 1;
      });
      while (shape.length > 1 && shape[shape.length - 1] === 1) {
        shape.pop();
      }
      contiguous = source.axes.every((value, index) => value === index) && input.contiguous;
      break;
    }
    case 'rotaryEmbedding': {
      const input = activation({ id: source.input });
      const dimensions = dimension({ value: source.dimensions, allowTokens: false });
      const frequencyBase = scalar({ value: source.frequencyBase }), frequencyScale = scalar({ value: source.frequencyScale });
      if (input.shape.length !== 3 || input.shape[2] !== inputTokens || dimensions > input.shape[0]! || dimensions % 2 !== 0 || Math.fround(frequencyBase) <= 1 || Math.fround(frequencyScale) <= 0) {
        throw new Error('Unsupported rotary embedding dimensions or scaling');
      }
      const scaling = source.scaling;
      const contextOriginal = scaling ? scalar({ value: scaling.contextOriginal }) : 0;
      const extensionFactor = scaling ? scalar({ value: scaling.extensionFactor }) : 0;
      const attentionFactor = scaling ? scalar({ value: scaling.attentionFactor }) : 1;
      const betaFast = scaling ? scalar({ value: scaling.betaFast }) : 32;
      const betaSlow = scaling ? scalar({ value: scaling.betaSlow }) : 1;
      if (!Number.isSafeInteger(contextOriginal) || contextOriginal < 0 || contextOriginal > 2147483647 || extensionFactor < 0
        || attentionFactor <= 0 || betaFast <= 0 || betaSlow <= 0 || betaFast < betaSlow || extensionFactor > 0 && contextOriginal === 0) {
        throw new Error('Invalid rotary extrapolation contract');
      }
      if (source.frequencyFactors !== undefined) {
        const factors = activation({ id: source.frequencyFactors });
        if (factors.shape.length !== 1 || factors.shape[0]! < dimensions / 2) {
          throw new Error('Rotary frequency factors must cover every pair');
        }
      }
      node = { ...source, dimensions, frequencyBase, frequencyScale, frequencyFactors: source.frequencyFactors, contextOriginal, extensionFactor, attentionFactor, betaFast, betaSlow };
      shape = [...input.shape];
      break;
    }
    case 'attentionCached': {
      const query = f32({ id: source.query }), key = f32({ id: source.key }), value = f32({ id: source.value });
      const slot = slots.find(slot => slot.id === source.slot);
      if (!slot || query.shape.length !== 3 || key.shape.length !== 3 || value.shape.length !== 3 || query.shape[0] !== slot.headSize || key.shape[0] !== slot.headSize || value.shape[0] !== slot.headSize || key.shape[1] !== slot.heads || value.shape[1] !== slot.heads || query.shape[1]! % slot.heads !== 0 || query.shape[2] !== inputTokens || key.shape[2] !== inputTokens || value.shape[2] !== inputTokens) {
        throw new Error('Attention head, slot, or token dimensions do not match');
      }
      const scale = source.scale === 'inverseSqrtHead' ? 1 / Math.sqrt(slot.headSize) : scalar({ value: source.scale });
      if (Math.fround(scale) <= 0) {
        throw new Error('Attention scale must be positive');
      }
      node = { ...source, scale };
      shape = [slot.headSize * query.shape[1]!, inputTokens];
      break;
    }
    default: {
      const exhaustive: never = source;
      throw new Error(String(exhaustive));
    }
    }
    // Check arithmetic before creating native metadata. The scheduler measures
    // peak compute storage later: aliases, shared masks and nonoverlapping
    // activation lifetimes are not independent retained allocations.
    largestTensorBytes = Math.max(largestTensorBytes, modelGraphTensorBytes({ shape, type: outputType }));
    tensors.set(node.id, { shape, type: outputType, contiguous, indices });
    nodes.push({ node, shape });
  }
  for (const update of definition.state.updates) {
    const target = persistent.find(value => value.id === update.slot)!;
    const value = lookup({ id: update.value });
    if (!value.contiguous || value.type !== target.precision || !sameShape({ left: value.shape, right: target.shape })) {
      throw new Error(`Persistent update needs the exact shape, precision and contiguous layout: ${update.slot}`);
    }
  }
  const output = f32({ id: definition.outputs.logits });
  if (!output.contiguous || !sameShape({ left: output.shape, right: [inventory.vocabularySize, inputTokens] })) {
    throw new Error('Logits must be contiguous with shape [vocabulary, input tokens]');
  }
  return { definition, tensors: persistent, updates: definition.state.updates, extraTensorCount, weights, slots, nodes, logits: definition.outputs.logits, inputTokens, cacheTokens, capacity, vocabularySize: inventory.vocabularySize, stateBytes: Number(stateBytes), largestTensorBytes };
}

export const TEST_ONLY = {
};
