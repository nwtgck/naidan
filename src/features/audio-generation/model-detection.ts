import { storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { modelSchema, type LocalModel } from '@/features/llama-cpp-browser/types';
import { readAudioGgufMetadata, type GgufMetadataFile, type GgufMetadataValue } from './gguf-metadata';
import type { AudioGenerationResult } from './types';

export type AudioModelDetection =
  | { status: 'detected', pipeline: AudioGenerationResult['pipeline'], reference: 'optional' | 'required' }
  | { status: 'unverified', reason: 'metadata' | 'architecture' | 'companion' };

/** Metadata is an advisory candidate filter, never a replacement for the native
 * model/pipeline checks. Names, repository labels and quantization are not proof.
 * The exact companion selected by the inference loader is inspected, not another
 * similarly named file elsewhere in the directory.
 */
export async function detectAudioModelFiles({ directory, signal }: {
  directory: Pick<ModelDirectory, 'modelPath' | 'projectorPath'> & { files: readonly { path: string, file: GgufMetadataFile }[] }, signal: AbortSignal | undefined,
}): Promise<AudioModelDetection> {
  signal?.throwIfAborted();
  try {
    const backbone = directory.files.find(entry => entry.path === directory.modelPath);
    if (!backbone) return { status: 'unverified', reason: 'metadata' };
    const metadata = await readAudioGgufMetadata({ file: backbone.file, keys: ['general.architecture'], signal });
    const architecture = metadata.get('general.architecture');
    let pipeline: AudioGenerationResult['pipeline']; let projector: string; let reference: 'optional' | 'required';
    switch (architecture) {
    case 'qwen3tts': pipeline = 'qwen3-tts'; projector = 'qwen3tts_gen'; reference = 'optional'; break;
    case 'pockettts': pipeline = 'pocket-tts'; projector = 'pockettts_gen'; reference = 'required'; break;
    default: return { status: 'unverified', reason: 'architecture' };
    }
    const companion = directory.files.find(entry => entry.path === directory.projectorPath);
    if (!companion) return { status: 'unverified', reason: 'companion' };
    const details = await readAudioGgufMetadata({ file: companion.file, keys: ['clip.has_gen_audio_encoder', 'clip.gen.audio.projector_type'], signal });
    if (!hasGenerator({ details, projector })) return { status: 'unverified', reason: 'companion' };
    return { status: 'detected', pipeline, reference };
  } catch {
    signal?.throwIfAborted();
    // Truncation, unfamiliar metadata and storage races must not make a model
    // impossible to choose through the all-models escape hatch.
    return { status: 'unverified', reason: 'metadata' };
  }
}
function hasGenerator({ details, projector }: { details: ReadonlyMap<string, GgufMetadataValue>, projector: string }): boolean {
  return details.get('clip.has_gen_audio_encoder') === true && details.get('clip.gen.audio.projector_type') === projector;
}
export async function inspectStoredAudioModel({ id, signal }: { id: string, signal: AbortSignal | undefined }): Promise<AudioModelDetection> {
  signal?.throwIfAborted();
  try {
    const name = modelSchema.shape.id.parse(id);
    const directory = await storedModelDirectory({ name });
    return await detectAudioModelFiles({ directory, signal });
  } catch {
    signal?.throwIfAborted();
    return { status: 'unverified', reason: 'metadata' };
  }
}
export function preferredAudioModel({ models, detections }: {
  models: readonly LocalModel[], detections: ReadonlyMap<string, AudioModelDetection>,
}): string | undefined {
  // Prefer a usable no-reference workflow, then the smaller local footprint.
  // File size is not a quality ranking or a promise about peak runtime memory.
  const candidates = models.filter(model => detections.get(model.id)?.status === 'detected');
  const referenceRank = ({ id }: { id: string }): number => {
    const detection = detections.get(id);
    return detection?.status === 'detected' && detection.reference === 'optional' ? 0 : 1;
  };
  candidates.sort((a, b) => referenceRank(a) - referenceRank(b) || a.size - b.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates[0]?.id;
}
export const TEST_ONLY = {
};
