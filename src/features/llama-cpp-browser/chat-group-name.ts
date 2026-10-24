import type { LocalModel } from './types';

/** The initial chat-group label follows the readable model selection. */
export function localModelChatGroupName({ model }: { model: LocalModel }): string {
  const basename = model.modelId.split('/').at(-1) || model.modelId;
  // Single-file imports append -GGUF to their root. Preserve literal percent
  // sequences and variants rather than treating modelId as an encoded path.
  return /^(?:user|temp)\//i.test(model.modelId) && !model.modelId.includes(':') && /-GGUF$/i.test(basename)
    ? basename.slice(0, -'-GGUF'.length) || basename
    : basename;
}

export const TEST_ONLY = {
};
