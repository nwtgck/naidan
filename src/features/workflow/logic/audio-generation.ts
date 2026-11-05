import { audioGenerationResultSchema, MAX_REFERENCE_BYTES, type AudioGenerationInput, type AudioGenerationResult } from '@/features/audio-generation/types';
import { validateAudioWav } from '@/features/audio-generation/wav';
import { normalizeReferenceAudio } from '@/features/audio-generation/reference-audio';
import type { WorkflowAudioGenerationInput, WorkflowOutputs } from './runtime';
import type { WorkflowOutput } from './output-store';
import { readOutput } from './values';
import { workflowAudioRequestSchema } from './audio-input';

export type WorkflowAudioEngine = ({ input, cancellationSignal }: { input: Omit<AudioGenerationInput, 'options'>, cancellationSignal: AbortSignal }) => Promise<AudioGenerationResult>;
export type WorkflowAudioReferenceNormalizer = typeof normalizeReferenceAudio;

/** Await the engine's cancellation acknowledgement. Racing an active generation
 * would release ownership while the shared worker is still generating audio.
 */
export async function generateWorkflowAudio({ input, generate, normalizeReference }: {
  input: WorkflowAudioGenerationInput, generate: WorkflowAudioEngine, normalizeReference: WorkflowAudioReferenceNormalizer,
}): Promise<WorkflowOutputs> {
  const { signal, store, reference: source, onLimit } = input;
  signal.throwIfAborted();
  const request = workflowAudioRequestSchema.parse(input.request);
  let reference: Blob | undefined;
  if (source !== undefined) {
    const size = source.output.byteLength;
    if (size <= 0 || size > MAX_REFERENCE_BYTES) {
      throw new Error('Audio reference must be a nonempty binary file no larger than 16 MiB.');
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for await (const chunk of readOutput({ output: source.output, signal })) {
      if (chunk.byteLength > size - offset) {
        throw new Error('Audio reference exceeds its declared size.');
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== size) {
      throw new Error('Audio reference is truncated.');
    }
    // Workflow binary handles have no trustworthy file extension. Decode and
    // normalize explicitly, rejecting overlong voices rather than trimming them.
    reference = (await normalizeReference({ source: new Blob([bytes]), signal, durationPolicy: 'reject' })).wav;
  }
  signal.throwIfAborted();
  const result = audioGenerationResultSchema.parse(await generate({ input: { ...request, reference, debug: 'off' }, cancellationSignal: signal }));
  signal.throwIfAborted();
  validateAudioWav({ wav: result.wav, sampleRate: result.sampleRate, samples: result.samples });
  switch (result.finishReason) {
  case 'stop': break;
  case 'user-stop': throw new Error('Audio generation stopped without a completed output.');
  case 'frame-limit':
  case 'context-limit':
    switch (onLimit) {
    case 'keep': break;
    case 'error': throw new Error(`Audio generation reached ${result.finishReason}; incomplete audio was not published.`);
    default: {
      const exhaustive: never = onLimit;
      throw new Error(String(exhaustive));
    }
    }
    break;
  default: {
    const exhaustive: never = result.finishReason;
    throw new Error(String(exhaustive));
  }
  }
  const writer = await store.createWriter({ signal });
  let output: WorkflowOutput | undefined;
  try {
    for (let offset = 0; offset < result.wav.byteLength; offset += 32768) {
      signal.throwIfAborted();
      await writer.write({ chunk: result.wav.subarray(offset, offset + 32768) });
    }
    output = await writer.seal();
    signal.throwIfAborted();
    return {
      audio: { type: 'binary', output, format: 'wav' },
      complete: { type: 'json', value: result.finishReason === 'stop' },
      metadata: { type: 'json', value: { sampleRate: result.sampleRate, samples: result.samples, frames: result.frames, finishReason: result.finishReason, pipeline: result.pipeline, byteLength: result.wav.byteLength } },
    };
  } catch (reason) {
    if (output) {
      await output.release();
    } else {
      await writer.abort({ reason });
    }
    throw reason;
  }
}

export const TEST_ONLY = {
};
