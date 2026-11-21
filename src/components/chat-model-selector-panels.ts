import { lazyStrings } from '@/strings';

export function browserChatModelPanels({ includeFiles }: { includeFiles: boolean }) {
  const panels = [
    { id: 'chat-candidates', label: lazyStrings.ChatInput__chat_model_suggestions(), placement: 'before-models' },
    { id: 'huggingface', label: 'Hugging Face' },
  ] as const;
  return includeFiles ? [...panels, { id: 'files', label: lazyStrings.ModelSelector__add_files() }] as const : panels;
}

export const TEST_ONLY = {
};
