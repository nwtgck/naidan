// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { preProcessFile } from 'typescript';
import { BOUNDARY_STRING_LOCALES } from './boundary-strings/message-catalog';

it('keeps peer management and image RPC copy translated and independently registered in all supported locales', () => {
  const root = path.resolve(import.meta.dirname, '../src/strings');
  const scopes = ['naidanRpc__', 'NaidanRpcTab__', 'ImageExecutionTarget__', 'ImageRecoveredOutputs__', 'ImagePendingRuns__'];
  const keys = fs.readdirSync(path.join(root, 'messages')).filter(key => scopes.some(scope => key.startsWith(scope)));
  expect(keys.length).toBeGreaterThan(69);
  const catalogs = new Map(BOUNDARY_STRING_LOCALES.map(locale => [locale, fs.readFileSync(path.join(root, 'catalogs', locale + '.ts'), 'utf8')]));
  for (const key of keys) {
    const english = fs.readFileSync(path.join(root, 'messages', key, 'en.ts'), 'utf8');
    for (const locale of BOUNDARY_STRING_LOCALES) {
      const source = fs.readFileSync(path.join(root, 'messages', key, locale + '.ts'), 'utf8');
      expect(source, key + '/' + locale).not.toContain('English fallback pending translation');
      expect(preProcessFile(source, true, true).importedFiles, key + '/' + locale).toHaveLength(0);
      expect(catalogs.get(locale)).toContain(`import { ${key} } from '@/strings/messages/${key}/${locale}';`);
      expect(catalogs.get(locale)).toContain(`  ${key},`);
      // The product name and the German "Details" label intentionally match English.
      // They still need independent locale implementations and catalog registrations.
      const intentionallyMatchesEnglish = key === 'naidanRpc__title'
        || (key === 'NaidanRpcTab__method_details' && locale === 'de');
      if (locale !== 'en' && !intentionallyMatchesEnglish) expect(source.trim(), key + '/' + locale).not.toBe(english.trim());
    }
  }
});
