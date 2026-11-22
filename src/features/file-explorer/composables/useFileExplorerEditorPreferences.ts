import { computed, ref } from 'vue';
import { useFileExplorerPreferences } from './useFileExplorerPreferences';

const temporaryWordWrap = ref(false);
const temporaryLineNumbers = ref<'shown' | 'hidden'>('shown');

export function useFileExplorerTextWrap() {
  const { preferences, initialized, captureStorage, savePreferences } = useFileExplorerPreferences();
  return computed({
    get: () => initialized.value ? preferences.value?.wordWrap === 'wrap' : temporaryWordWrap.value,
    set: (enabled: boolean) => {
      if (initialized.value) {
        void savePreferences({ patch: { wordWrap: enabled ? 'wrap' : 'no_wrap' }, isCurrent: captureStorage() });
      } else {
        temporaryWordWrap.value = enabled;
      }
    },
  });
}

export function useFileExplorerLineNumbers() {
  const { preferences, initialized, captureStorage, savePreferences } = useFileExplorerPreferences();
  return computed({
    get: () => initialized.value ? preferences.value?.editorLineNumbers ?? 'shown' : temporaryLineNumbers.value,
    set: (value: 'shown' | 'hidden') => {
      if (initialized.value) {
        void savePreferences({ patch: { editorLineNumbers: value }, isCurrent: captureStorage() });
      } else {
        temporaryLineNumbers.value = value;
      }
    },
  });
}

export const TEST_ONLY = {
  temporaryWordWrap,
};
