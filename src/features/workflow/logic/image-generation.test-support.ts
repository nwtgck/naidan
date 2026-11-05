import { vi } from 'vitest';
import { parametersFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { deflateSync, crc32 } from 'node:zlib';
import type { WorkflowStep } from '@/01-models/workflow';
import type { BrowserImageModelSelection } from '@/01-models/types';
import type { Response } from '@/features/stable-diffusion-cpp-browser/types';
import type { ModelCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { stepId, literal } from './workflow.test-support';
import { defaultWorkflowImageParameters, workflowImageRequestSchema, type WorkflowImageRequest } from './image-input';
import { createOutputStoreFixture } from './output-store.test-support';
import { generateWorkflowImage, type WorkflowImageEngine } from './image-generation';
import type { WorkflowImageGenerationInput, WorkflowOutputs } from './runtime';
import { releaseValues } from './values';

export function imageSelection(): BrowserImageModelSelection {
  return { primary: { slot: 'model', location: { kind: 'opfs', path: 'models/user/example/model.gguf' } }, components: [{ slot: 'vae', choice: { kind: 'none' } }], loras: [] };
}

export function imageStep({ id }: { id: string }): Extract<WorkflowStep, { type: 'image_generation' }> {
  return { id: stepId({ raw: id }), name: id, type: 'image_generation', model: { type: 'literal', value: imageSelection() }, prompt: literal({ value: 'A tree' }), parameters: defaultWorkflowImageParameters(), gpuBudgetMiB: undefined };
}

export function imageRequest(): WorkflowImageRequest {
  const { prompt: _prompt, ...parameters } = parametersFixture();
  return workflowImageRequestSchema.parse({ model: imageSelection(), prompt: 'A tree', parameters: { ...parameters, profile: 'auto', weightResidency: 'auto' } });
}

export function imageResult({ width, height, compression }: { width: number, height: number, compression: 'small' | 'uncompressed' }): Response {
  function chunk({ name, bytes }: { name: string, bytes: Uint8Array }): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(bytes.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, bytes.length);
    result.set(new TextEncoder().encode(name), 4);
    result.set(bytes, 8);
    view.setUint32(bytes.length + 8, crc32(result.subarray(4, bytes.length + 8)));
    return result;
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const pixels = new Uint8Array((width * 3 + 1) * height);
  const level = (() => {
    switch (compression) {
    case 'small': return 9;
    case 'uncompressed': return 0;
    default: {
      const exhaustive: never = compression;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const compressed = deflateSync(pixels, { level });
  const png = new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk({ name: 'IHDR', bytes: header }),
    chunk({ name: 'IDAT', bytes: compressed }),
    chunk({ name: 'IEND', bytes: new Uint8Array() }),
  ], { type: 'image/png' });
  return { png, width, height, modelVersion: 'fixture', uniformOutput: true };
}

export function imageCandidate({ overrides }: { overrides: Partial<ModelCandidate> }): ModelCandidate {
  return { candidateKey: 'model', repositoryKey: 'user/example', primaryRelativePath: 'model.gguf', files: [{ relativePath: 'model.gguf', file: new File([new Uint8Array(16)], 'model.gguf') }], format: 'gguf', size: 16, family: 'sd-checkpoint', classes: [], roles: ['model'], evidence: [], issue: undefined, turboHint: false, variant: 'base', ...overrides };
}

export function imageFixture() {
  const fixture = createOutputStoreFixture({ limits: { maxBytes: 1024 * 1024, maxOutputBytes: 512 * 1024, maxWriteChunkBytes: 32768, maxPendingWriteBytes: 65536, readChunkBytes: 8192 } });
  const controller = new AbortController();
  const result = imageResult({ width: 256, height: 256, compression: 'small' });
  const generate = vi.fn<WorkflowImageEngine>(async () => ({ result, profile: 'webgpu-wasm32-asyncify' }));
  const input: WorkflowImageGenerationInput = { step: imageStep({ id: 'image' }), request: imageRequest(), targetSources: ['definition'], signal: controller.signal, store: fixture.store };
  const owned: WorkflowOutputs[] = [];
  return {
    ...fixture,
    controller,
    result,
    generate,
    input,
    async execute({ overrides }: { overrides: Partial<WorkflowImageGenerationInput> }) {
      const outputs = await generateWorkflowImage({ input: { ...input, ...overrides }, generate, onProgress: () => undefined });
      owned.push(outputs);
      return outputs;
    },
    async [Symbol.asyncDispose]() {
      controller.abort();
      await releaseValues({ values: owned.flatMap(Object.values) });
      await fixture[Symbol.asyncDispose]();
    },
  };
}

export const TEST_ONLY = {
};
