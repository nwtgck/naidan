import { describe, expect, it } from 'vitest';

import { UI_LOCALES } from '@/01-models/ui-locale';
import { createPortableAppDownloadTarget } from './portable-app-download';

describe('Portable App download target', () => {
  it.each(UI_LOCALES)('uses the current %s locale package and versioned filename', (locale) => {
    expect(createPortableAppDownloadTarget({ locale, version: '0.42.0' })).toEqual({
      href: `./naidan-standalone-${locale}.zip`,
      fileName: `naidan-standalone-${locale}-v0.42.0.zip`,
    });
  });
});
