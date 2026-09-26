import { describe, expect, it, vi } from 'vitest';

import { createBoundaryStringCatalogState } from './catalog-state';
import { createBoundaryStringDiagnosticError } from './diagnostics';
import { BOUNDARY_STRING_LOCALES, type BoundaryStringMessageCatalog } from './message-catalog';

function catalog({ key }: {
  key: string;
}): BoundaryStringMessageCatalog {
  const message = {
    key,
    modulesByLocale: Object.fromEntries(BOUNDARY_STRING_LOCALES.map((locale) => [
      locale,
      {
        filePath: `/messages/${key}/${locale}.ts`,
        sourceModuleId: `/messages/${key}/${locale}.ts`,
      },
    ])) as BoundaryStringMessageCatalog['messages'][number]['modulesByLocale'],
  };
  return {
    messages: [message],
    messagesByKey: new Map([[key, message]]),
  };
}

describe('Boundary Strings catalog state', () => {
  it('resolves a generation once and refreshes after a dirty mark', () => {
    const first = catalog({ key: 'Example__first' });
    const second = catalog({ key: 'Example__second' });
    const readCatalog = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const state = createBoundaryStringCatalogState({ readCatalog });

    expect(state.resolve()).toEqual({ catalog: first, status: 'valid' });
    expect(state.resolve()).toEqual({ catalog: first, status: 'valid' });
    state.markDirty();
    expect(state.resolve()).toEqual({ catalog: second, status: 'valid' });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('caches deterministic diagnostics for the current generation', () => {
    const readCatalog = vi.fn(() => {
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-locale-mismatch',
        message: 'mismatch',
      });
    });
    const state = createBoundaryStringCatalogState({ readCatalog });

    expect(state.resolve()).toEqual({
      diagnostic: {
        code: 'catalog-locale-mismatch',
        message: 'mismatch',
      },
      status: 'invalid',
    });
    expect(state.resolve()).toEqual({
      diagnostic: {
        code: 'catalog-locale-mismatch',
        message: 'mismatch',
      },
      status: 'invalid',
    });
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it('revalidates an invalid snapshot after a locale content event without hiding real omissions', () => {
    const repaired = catalog({ key: 'stableDiffusionCppBrowser__decoding_image' });
    const missing = createBoundaryStringDiagnosticError({
      code: 'message-locale-file-missing',
      message: 'Missing en.ts for catalog message "stableDiffusionCppBrowser__decoding_image".',
    });
    const readCatalog = vi.fn()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValue(repaired);
    const state = createBoundaryStringCatalogState({ readCatalog });

    expect(state.resolve()).toMatchObject({ status: 'invalid' });
    expect(state.markDirtyIfInvalid()).toBe(true);
    expect(state.resolve()).toMatchObject({ status: 'invalid', diagnostic: missing.diagnostic });
    expect(state.markDirtyIfInvalid()).toBe(true);
    expect(state.resolve()).toEqual({ status: 'valid', catalog: repaired });
    expect(readCatalog).toHaveBeenCalledTimes(3);
  });

  it('does not read or invalidate valid or unresolved catalogs for an ordinary message edit', () => {
    const current = catalog({ key: 'Example__first' });
    const readCatalog = vi.fn(() => current);
    const state = createBoundaryStringCatalogState({ readCatalog });
    expect(state.markDirtyIfInvalid()).toBe(false);
    expect(readCatalog).not.toHaveBeenCalled();
    expect(state.resolve()).toEqual({ catalog: current, status: 'valid' });
    expect(state.markDirtyIfInvalid()).toBe(false);
    expect(state.resolve()).toEqual({ catalog: current, status: 'valid' });
    expect(readCatalog).toHaveBeenCalledOnce();
  });

  it('does not cache unexpected failures', () => {
    const readCatalog = vi.fn(() => {
      throw new Error('transient I/O failure');
    });
    const state = createBoundaryStringCatalogState({ readCatalog });

    expect(() => state.resolve()).toThrow('transient I/O failure');
    expect(() => state.resolve()).toThrow('transient I/O failure');
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('retries an unexpected failure from an unknown-key probe', () => {
    const initial = catalog({ key: 'Example__existing' });
    const readCatalog = vi.fn()
      .mockReturnValueOnce(initial)
      .mockImplementationOnce(() => {
        throw new Error('transient I/O failure');
      })
      .mockReturnValueOnce(initial);
    const state = createBoundaryStringCatalogState({ readCatalog });

    expect(() => state.resolveForBoundary({
      keys: ['Example__missing'],
      moduleId: '/src/example.ts',
    })).toThrow('transient I/O failure');
    expect(state.resolveForBoundary({
      keys: ['Example__missing'],
      moduleId: '/src/example.ts',
    })).toMatchObject({
      diagnostic: {
        code: 'unknown-message-key',
      },
      status: 'invalid',
    });
    expect(readCatalog).toHaveBeenCalledTimes(3);
  });

  it('probes an unknown key only once per generation', () => {
    const initial = catalog({ key: 'Example__existing' });
    const readCatalog = vi.fn(() => initial);
    const state = createBoundaryStringCatalogState({ readCatalog });

    const first = state.resolveForBoundary({
      keys: ['Example__missing'],
      moduleId: '/src/example.ts',
    });
    const second = state.resolveForBoundary({
      keys: ['Example__missing'],
      moduleId: '/src/example.ts',
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      diagnostic: {
        code: 'unknown-message-key',
        message: '[naidan-boundary-strings] Unknown message key "Example__missing" in /src/example.ts.',
      },
      status: 'invalid',
    });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('recovers an unknown key when the forced probe sees the new catalog', () => {
    const readCatalog = vi.fn()
      .mockReturnValueOnce(catalog({ key: 'Example__existing' }))
      .mockReturnValueOnce(catalog({ key: 'Example__new' }));
    const state = createBoundaryStringCatalogState({ readCatalog });

    const resolution = state.resolveForBoundary({
      keys: ['Example__new'],
      moduleId: '/src/example.ts',
    });

    expect(resolution.status).toBe('valid');
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });
});
