import { readGgufMetadata, type GgufMetadataFile } from '@/utils/gguf-metadata';
import { speechError } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionCandidateInfo } from './types';

/** Header selection only. The native model-info API validates tensor layout,
 * language options and the supported speech.cpp file version before loading. */
export async function inspectSpeechRecognitionCandidate({ file, name, signal }: { file: GgufMetadataFile, name: string, signal: AbortSignal | undefined }): Promise<{ kind: 'recognition', info: SpeechRecognitionCandidateInfo } | { kind: 'other' }> {
  const architectureValues = await readGgufMetadata({ file, keys: ['general.architecture'], signal, maxStringBytes: 4096 });
  const architecture = architectureValues.get('general.architecture');
  if (architecture !== 'qwen3-asr' && architecture !== 'fastconformer') {
    return { kind: 'other' };
  }
  const values = await readGgufMetadata({ file, keys: ['speech.task', 'speech.sample_rate', 'speech.requires', 'speech.layout', 'split.count'], signal, maxStringBytes: 4096 });
  if (values.get('speech.task') !== 'recognition') {
    return { kind: 'other' };
  }
  const sampleRate = values.get('speech.sample_rate'), requiredVersion = values.get('speech.requires');
  if (typeof sampleRate !== 'number' || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || typeof requiredVersion !== 'string' || values.get('speech.layout') !== 1 || (values.get('split.count') !== undefined && values.get('split.count') !== 1)) {
    throw speechError({ code: 'invalid_model', message: 'Expected a complete speech.cpp recognition GGUF with supported audio metadata' });
  }
  return { kind: 'recognition', info: { name, bytes: file.size, architecture, task: 'recognition', sampleRate, requiredVersion } };
}

export const TEST_ONLY = {
};
