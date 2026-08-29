import type { UiLocale } from '@/01-models/ui-locale';

export type PortableAppDownloadTarget = Readonly<{
  href: string;
  fileName: string;
}>;

export function createPortableAppDownloadTarget({ locale, version }: {
  locale: UiLocale;
  version: string;
}): PortableAppDownloadTarget {
  return {
    href: `./naidan-standalone-${locale}.zip`,
    fileName: `naidan-standalone-${locale}-v${version}.zip`,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
