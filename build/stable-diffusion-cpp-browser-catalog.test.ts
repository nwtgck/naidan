// @vitest-environment node
/// <reference types="vite/client" />
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
} from './boundary-strings/message-catalog';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = [
  'stableDiffusionCppBrowser__decoding_image',
  'stableDiffusionCppBrowser__apply_recommended_settings',
  'stableDiffusionCppBrowser__generation_time',
  'stableDiffusionCppBrowser__preview_after_step',
  'stableDiffusionCppBrowser__preview_start_step',
  'stableDiffusionCppBrowser__recommended_preview_summary',
  'stableDiffusionCppBrowser__recommended_settings',
] as const;
// Inspect the applied checkout, not generated translation fixtures. Catalog
// registration, files, named exports and callable messages must all agree.
const modules = import.meta.glob<Record<string, unknown>>(
  '../src/strings/messages/stableDiffusionCppBrowser__{decoding_image,apply_recommended_settings,generation_time,preview_after_step,preview_start_step,recommended_preview_summary,recommended_settings}/*.ts',
  { eager: true },
);

describe('checked-in image-generation locale files', () => {
  it('keeps every registered message resolvable in the applied source tree', () => {
    const catalog = readBoundaryStringMessageCatalog({
      root,
      paths: createBoundaryStringProjectPaths({ root }),
    });
    for (const key of keys) expect(catalog.messagesByKey.has(key), key).toBe(true);
    expect(Object.keys(modules).sort()).toEqual(keys.flatMap(key => BOUNDARY_STRING_LOCALES.map(locale =>
      `../src/strings/messages/${key}/${locale}.ts`,
    )).sort());
  });

  it.each(keys.flatMap(key => BOUNDARY_STRING_LOCALES.map(locale => ({ key, locale }))))('ships an executable $locale $key message', ({ key, locale }) => {
    const sourceId = `../src/strings/messages/${key}/${locale}.ts`;
    const message = modules[sourceId]?.[key];
    expect(message, sourceId).toBeTypeOf('function');
    if (typeof message !== 'function') throw new Error(`Missing named message function: ${sourceId}`);
    const text: unknown = message();
    expect(text).toBeTypeOf('string');
    if (typeof text !== 'string') throw new Error(`Non-string message: ${sourceId}`);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toContain(key);
  });
});
