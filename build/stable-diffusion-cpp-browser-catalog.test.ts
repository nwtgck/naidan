// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
} from './boundary-strings/message-catalog';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = 'stableDiffusionCppBrowser__decoding_image';
// Use the files in the applied checkout, not generated translation fixtures.
// A catalog import alone does not prove a locale implementation was shipped.
const decodingModules = import.meta.glob<Record<string, unknown>>(
  '../src/strings/messages/stableDiffusionCppBrowser__decoding_image/*.ts',
  { eager: true },
);

describe('checked-in image-generation locale files', () => {
  it('keeps every registered message resolvable in the applied source tree', () => {
    const catalog = readBoundaryStringMessageCatalog({
      root,
      paths: createBoundaryStringProjectPaths({ root }),
    });
    expect(catalog.messagesByKey.has(key)).toBe(true);
    expect(Object.keys(decodingModules).sort()).toEqual(BOUNDARY_STRING_LOCALES.map(locale =>
      `../src/strings/messages/${key}/${locale}.ts`,
    ).sort());
  });

  it.each(BOUNDARY_STRING_LOCALES)('ships an executable %s decoding message', locale => {
    const sourceId = `../src/strings/messages/${key}/${locale}.ts`;
    const message = decodingModules[sourceId]?.[key];
    expect(message, sourceId).toBeTypeOf('function');
    if (typeof message !== 'function') throw new Error(`Missing decoding message: ${sourceId}`);
    const text: unknown = message();
    expect(text).toBeTypeOf('string');
    if (typeof text !== 'string') throw new Error(`Non-string decoding message: ${sourceId}`);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toContain(key);
  });
});
