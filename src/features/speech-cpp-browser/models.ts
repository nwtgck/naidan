import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { inspectSpeechCandidate } from './worker/model-file';
import { speechError, type SpeechModelInfo } from './types';

/** The shared inventory resolves storage/selection; speech owns interpretation. */
async function capturePrimary({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<{ file: File, complete: boolean }> {
  const captured = await llamaCppBrowserModelFiles.captureModelFiles({ modelId, signal });
  const primary = captured.files.find(entry => entry.relativePath === captured.primaryRelativePath);
  if (primary === undefined) {
    throw speechError({ code: 'invalid_model', message: 'Haru dialogue requires one complete model file without companion selection' });
  }
  return { file: primary.file, complete: captured.files.length === 1 };
}

export async function inspectStoredSpeechModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<{ kind: 'speech', info: SpeechModelInfo } | { kind: 'other' }> {
  const { file, complete } = await capturePrimary({ modelId, signal });
  const candidate = await inspectSpeechCandidate({ file, name: file.name, signal });
  if (candidate.kind === 'speech' && !complete) {
    throw speechError({ code: 'invalid_model', message: 'Haru dialogue requires one complete model file without companions' });
  }
  return candidate;
}

/** Re-resolve and validate at acceptance, so replacing an inventory entry after
 * selection cannot pass a different model to the speech worker. */
export async function openStoredSpeechModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<File> {
  const { file, complete } = await capturePrimary({ modelId, signal });
  const candidate = await inspectSpeechCandidate({ file, name: file.name, signal });
  switch (candidate.kind) {
  case 'speech':
    if (!complete) {
      throw speechError({ code: 'invalid_model', message: 'Haru dialogue requires one complete model file without companions' });
    }
    return file;
  case 'other': throw speechError({ code: 'invalid_model', message: 'Selected model is not a Haru dialogue model' });
  default: {
    const exhaustive: never = candidate;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
