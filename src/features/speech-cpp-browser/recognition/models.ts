import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { speechError } from '@/features/speech-cpp-browser/types';
import { inspectSpeechRecognitionCandidate } from './model-file';

async function capture({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }) {
  const captured = await llamaCppBrowserModelFiles.captureModelFiles({ modelId, signal });
  const primary = captured.files.find(entry => entry.relativePath === captured.primaryRelativePath);
  if (primary === undefined) {
    throw speechError({ code: 'invalid_model', message: 'Recognition requires one complete model file' });
  }
  const candidate = await inspectSpeechRecognitionCandidate({ file: primary.file, name: primary.file.name, signal });
  if (candidate.kind === 'recognition' && captured.files.length !== 1) {
    throw speechError({ code: 'invalid_model', message: 'Recognition requires one complete model file without companions' });
  }
  return { candidate, file: primary.file };
}

export async function inspectStoredSpeechRecognitionModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }) {
  return (await capture({ modelId, signal })).candidate;
}

export async function openStoredSpeechRecognitionModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<File> {
  const { candidate, file } = await capture({ modelId, signal });
  switch (candidate.kind) {
  case 'recognition': return file;
  case 'other': throw speechError({ code: 'invalid_model', message: 'Selected model is not a supported speech recognition model' });
  default: {
    const exhaustive: never = candidate;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
