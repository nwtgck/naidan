import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { createModelGraphEngine } from './engine';
import { modelGraphFormat, parseModelGraphDefinitions, type ModelGraphDefinition, type ModelGraphNode } from './definition';
import type { TensorOperatorName } from './operators';
import type { ModelGraphInventory } from './compile';

export function tensorNode({ id, operator, inputs, attributes }: {
  id: string; operator: TensorOperatorName; inputs: string[]; attributes: Record<string, unknown>;
}): ModelGraphNode {
  return { id, op: 'tensor', operator, inputs, attributes };
}

export function constantNode({ id, shape, values }: { id: string; shape: number[]; values: number[] }): ModelGraphNode {
  return tensorNode({ id, operator: 'constant', inputs: [], attributes: { shape, values } });
}

export function tensorDefinition({ nodes, vocabulary, state }: {
  nodes: ModelGraphNode[]; vocabulary: number; state: ModelGraphDefinition['state'] | undefined;
}): { definition: ModelGraphDefinition; inventory: ModelGraphInventory } {
  const definition: ModelGraphDefinition = {
    format: modelGraphFormat,
    name: 'Generic tensor fixture',
    applicability: { architecture: 'tensor-fixture', metadata: [] },
    requiredCapabilities: ['tensor-graph/v1', 'tensor-operators/v2', 'persistent-state/v1', 'decoder-inputs/v1'],
    parameters: [],
    weights: [],
    state: state ?? { profile: 'decoder-state/v2', slots: [], tensors: [], updates: [] },
    graph: { nodes },
    outputs: { logits: nodes.at(-1)!.id },
  };
  parseModelGraphDefinitions({ input: JSON.stringify(definition) });
  return { definition, inventory: { architecture: 'tensor-fixture', metadata: new Map(), tensors: new Map(), vocabularySize: vocabulary } };
}

export async function tensorEngineFixture({ core, nodes, vocabulary, state }: {
  core: Core; nodes: ModelGraphNode[]; vocabulary: number; state: ModelGraphDefinition['state'] | undefined;
}) {
  const { definition, inventory } = tensorDefinition({ nodes, vocabulary, state });
  const engine = await createModelGraphEngine({
    core,
    definition,
    inventory,
    locations: new Map(),
    contextSize: 128,
    batchSize: 64,
    backend: 'cpu',
    threads: 1,
    maximumScratchBytes: 16 * 1024 * 1024,
    signal: undefined,
    onWeightProgress: undefined,
  });
  return {
    engine,
    read(): number[] {
      const bytes = core.bytes({ pointer: engine.logitsPointer, length: vocabulary * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Array.from({ length: vocabulary }, (_, index) => view.getFloat32(index * 4, true));
    },
    async [Symbol.asyncDispose]() {
      await engine.close();
    },
  };
}

export const TEST_ONLY = {
};
