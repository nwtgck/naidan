import { resolveModel } from '@/features/llama-cpp-browser/runtime/model-resolution';
import { readGgufMetadata, type GgufMetadataFile } from '@/utils/gguf-metadata';
import type { TranslationDetection } from './types';

export async function inspectTranslationGguf({ file, signal }: { file: GgufMetadataFile, signal: AbortSignal }): Promise<TranslationDetection> {
  const metadata = await readGgufMetadata({ file, signal, keys: ['general.architecture', 'tokenizer.chat_template'], maxStringBytes: 65536 });
  const template = metadata.get('tokenizer.chat_template');
  // Architecture alone also matches ordinary PLaMo chat models. Filenames can
  // be renamed and are not evidence of an embedded translation template.
  if (metadata.get('general.architecture') === 'plamo3' && typeof template === 'string'
    && ['translation', 'target_lang', 'source_lang', '<|plamo:tag|>', '<|plamo:msg|>', '<|plamo:key|>', '<|plamo:val|>', 'dataset', 'input', 'output'].every(part => template.includes(part))) {
    return { status: 'supported', profileId: 'plamo3-translate' };
  }
  return { status: 'unsupported' };
}

export async function inspectStoredTranslationModel({ modelId, signal }: { modelId: string, signal: AbortSignal }): Promise<TranslationDetection> {
  const resolved = await resolveModel({ modelId, signal });
  signal.throwIfAborted();
  return inspectTranslationGguf({ file: resolved.directory.primaryFile.file, signal });
}

export const TEST_ONLY = {
};
