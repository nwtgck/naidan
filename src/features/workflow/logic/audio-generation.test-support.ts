import { vi } from 'vitest';
import type { WorkflowStep } from '@/01-models/workflow';
import type { AudioGenerationResult } from '@/features/audio-generation/types';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { stepId, literal } from './workflow.test-support';
import { defaultWorkflowAudioParameters } from './audio-input';
import { createOutputStoreFixture } from './output-store.test-support';
import { generateWorkflowAudio, type WorkflowAudioEngine, type WorkflowAudioReferenceNormalizer } from './audio-generation';
import type { WorkflowAudioGenerationInput, WorkflowOutputs } from './runtime';
import { releaseValues } from './values';

export function audioStep({ id }: { id: string }): Extract<WorkflowStep, { type: 'audio_generation' }> {
  return { id: stepId({ raw: id }), name: id, type: 'audio_generation', modelId: literal({ value: 'voice.gguf' }), text: literal({ value: 'Hello' }), reference: undefined, parameters: defaultWorkflowAudioParameters(), onLimit: 'error' };
}

export function audioResult({ samples, finishReason }: { samples: number, finishReason: AudioGenerationResult['finishReason'] }): AudioGenerationResult {
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const write = ({ offset, text }: { offset: number, text: string }): void => {
    wav.set(new TextEncoder().encode(text), offset);
  };
  write({ offset: 0, text: 'RIFF' });
  view.setUint32(4, wav.byteLength - 8, true);
  write({ offset: 8, text: 'WAVE' });
  write({ offset: 12, text: 'fmt ' });
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write({ offset: 36, text: 'data' });
  view.setUint32(40, samples * 2, true);
  return { wav, sampleRate: 24000, samples, frames: 1, finishReason, pipeline: 'qwen3-tts' };
}

export function audioFixture() {
  const fixture = createOutputStoreFixture({ limits: { maxBytes: 1024 * 1024, maxOutputBytes: 512 * 1024, maxWriteChunkBytes: 32768, maxPendingWriteBytes: 65536, readChunkBytes: 8192 } });
  const controller = new AbortController();
  const result = audioResult({ samples: 4, finishReason: 'stop' });
  const generate = vi.fn<WorkflowAudioEngine>(async () => result);
  const normalize = vi.fn<WorkflowAudioReferenceNormalizer>(async ({ source }) => ({ wav: source, samples: 4, trimmed: false }));
  const input: WorkflowAudioGenerationInput = {
    step: audioStep({ id: 'voice' }),
    request: { ...defaultAudioParameters(), modelId: 'voice.gguf', text: 'Hello' },
    reference: undefined,
    onLimit: 'error',
    targetSources: ['definition'],
    signal: controller.signal,
    store: fixture.store,
  };
  const owned: WorkflowOutputs[] = [];
  return {
    ...fixture,
    controller,
    result,
    generate,
    normalize,
    input,
    async execute({ overrides }: { overrides: Partial<WorkflowAudioGenerationInput> }) {
      const outputs = await generateWorkflowAudio({ input: { ...input, ...overrides }, generate, normalizeReference: normalize });
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
