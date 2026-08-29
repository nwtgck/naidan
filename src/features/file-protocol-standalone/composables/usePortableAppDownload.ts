import { computed } from 'vue';

import { currentLocale } from '@/strings';
import { createPortableAppDownloadTarget } from '@/features/file-protocol-standalone/logic/portable-app-download';

export function usePortableAppDownload({ version }: {
  version: string;
}) {
  return computed(() => createPortableAppDownloadTarget({
    locale: currentLocale.value,
    version,
  }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
