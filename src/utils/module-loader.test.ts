import { describe, expect, it, vi } from 'vitest';
import { createModuleLoader } from './module-loader';

describe('createModuleLoader', () => {
  it('shares the in-flight module promise', async () => {
    const moduleValue = { value: 1 };
    const importModule = vi.fn().mockResolvedValue(moduleValue);
    const onPrefetchError = vi.fn();
    const loader = createModuleLoader({ importModule, onPrefetchError });

    const first = loader.load();
    const second = loader.load();

    await expect(first).resolves.toBe(moduleValue);
    await expect(second).resolves.toBe(moduleValue);
    expect(importModule).toHaveBeenCalledOnce();
  });

  it('reports prefetch failures without creating an unhandled rejection', async () => {
    const error = new Error('module failed');
    const importModule = vi.fn().mockRejectedValue(error);
    const onPrefetchError = vi.fn();
    const loader = createModuleLoader({ importModule, onPrefetchError });

    await loader.prefetch();
    expect(onPrefetchError).toHaveBeenCalledWith({ error });
  });

  it('retries after a failed load', async () => {
    const moduleValue = { value: 2 };
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(moduleValue);
    const loader = createModuleLoader({ importModule, onPrefetchError: vi.fn() });

    await expect(loader.load()).rejects.toThrow('temporary failure');
    await expect(loader.load()).resolves.toBe(moduleValue);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('converts synchronous import errors to rejected promises', async () => {
    const error = new Error('synchronous failure');
    const loader = createModuleLoader({
      importModule: () => {
        throw error;
      },
      onPrefetchError: vi.fn(),
    });

    await expect(loader.load()).rejects.toBe(error);
  });
});
