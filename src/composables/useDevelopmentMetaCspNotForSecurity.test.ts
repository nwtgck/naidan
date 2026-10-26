import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, shallowRef, watch } from 'vue';
import type { Settings } from '@/01-models/types';

afterEach(() => {
  document.head.querySelectorAll('[data-naidan-developer-csp]').forEach(element => element.remove());
  vi.doUnmock('@/composables/useSettings');
  vi.doUnmock('@/logic/csp-message-hints');
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture({ serialized, initialized }: { serialized: string | undefined, initialized: boolean }) {
  const settings = shallowRef<{ experimental: Settings['experimental'] }>({ experimental: { metaCspForDevelopmentNotForSecurity: serialized, fakeLm: 'enabled' } });
  const ready = shallowRef(initialized);
  let stored = settings.value.experimental;
  let storageCurrent = true;
  const capture = vi.fn(() => () => storageCurrent);
  const update = vi.fn(async ({ isCurrent, updater }: {
    isCurrent(): boolean,
    updater({ experimental }: { experimental: Settings['experimental'] }): Settings['experimental'],
  }): Promise<'saved' | 'changed'> => {
    if (!isCurrent()) {
      return 'changed';
    }
    const next = updater({ experimental: stored });
    if (!isCurrent()) {
      return 'changed';
    }
    stored = next;
    settings.value = { experimental: next };
    return 'saved';
  });
  vi.doMock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, initialized: ready, captureExperimentalStorage: capture, updateExperimentalForStorage: update }) }));
  const preload = vi.fn(() => ({}));
  vi.doMock('@/logic/csp-message-hints', preload);
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const { useDevelopmentMetaCspNotForSecurity } = await import('./useDevelopmentMetaCspNotForSecurity');
  const scope = effectScope();
  const api = scope.run(() => useDevelopmentMetaCspNotForSecurity());
  if (api === undefined) {
    throw new Error('The development runtime fixture must have a scope.');
  }
  return {
    api,
    settings,
    ready,
    update,
    reload,
    preload,
    setStorageCurrent({ current }: { current: boolean }) {
      storageCurrent = current;
    },
    setStored({ experimental }: { experimental: Settings['experimental'] }) {
      stored = experimental;
    },
    getStored() {
      return stored;
    },
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

describe('persisted development meta and resident recovery adapter', () => {
  it('reapplies a saved policy only after dependencies and resident recovery are ready', async () => {
    using test = await fixture({ serialized: "default-src 'none'", initialized: true });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(test.preload).not.toHaveBeenCalled();
    expect(document.head.querySelector<HTMLMetaElement>('[data-naidan-developer-csp]')?.content).toBe("default-src 'none'");
    expect(test.api.snapshot.value.installation).toMatchObject({ kind: 'added', source: 'saved-setting' });
    expect(test.update).not.toHaveBeenCalled();
    expect(test.reload).not.toHaveBeenCalled();
  });

  it('does not latch initialization before settings have been read', async () => {
    using test = await fixture({ serialized: "script-src 'none'", initialized: false });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(test.preload).not.toHaveBeenCalled();
    test.ready.value = true;
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(test.api.snapshot.value.installation.kind).toBe('added');
  });

  it('retries initialization when resident recovery becomes available later', async () => {
    using test = await fixture({ serialized: "script-src 'none'", initialized: true });
    let resident = false;
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => resident });
    expect(test.api.additions.value).toHaveLength(0);
    resident = true;
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => resident });
    expect(test.api.additions.value).toHaveLength(1);
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => resident });
    expect(test.api.additions.value).toHaveLength(1);
  });

  it.each([undefined, ''])('does not import diagnostics or install a meta for an absent saved policy: %s', async serialized => {
    using test = await fixture({ serialized, initialized: true });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(test.preload).not.toHaveBeenCalled();
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
  });

  it('rejects an oversized restored value without trimming it or importing preparation chunks', async () => {
    const serialized = ' '.repeat(65_537);
    using test = await fixture({ serialized, initialized: true });
    const originalTrim = String.prototype.trim;
    vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === serialized) {
        throw new Error('Oversized restored values must not be trimmed.');
      }
      return originalTrim.call(this);
    });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(test.api.snapshot.value).toMatchObject({ reason: 'invalid-policy', installation: { kind: 'not-added' } });
    expect(test.preload).not.toHaveBeenCalled();
    expect(await test.api.clearDevelopmentMetaCspNotForSecurity()).toBe('saved');
  });

  it('does not make native additions depend on optional hint chunks', async () => {
    using test = await fixture({ serialized: "default-src 'none'", initialized: true });
    vi.doMock('@/logic/csp-message-hints', () => {
      throw new Error('preparation chunk unavailable');
    });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).not.toBeNull();
    expect(test.preload).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
  });

  it('clears through the resident save path without reloading or removing enforced DOM', async () => {
    using test = await fixture({ serialized: "script-src 'none'; default-src 'none'", initialized: true });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    const meta = document.head.querySelector<HTMLMetaElement>('[data-naidan-developer-csp]');
    const additions = test.api.additions.value;
    expect(meta).not.toBeNull();
    const result = await test.api.clearDevelopmentMetaCspNotForSecurity();
    expect(result).toBe('saved');
    expect(test.getStored()?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(test.getStored()?.fakeLm).toBe('enabled');
    expect(test.reload).not.toHaveBeenCalled();
    expect(meta?.isConnected).toBe(true);
    expect(meta?.content).toBe("script-src 'none'; default-src 'none'");
    expect(test.preload).not.toHaveBeenCalled();
    expect(test.api.additions.value).toBe(additions);
  });

  it('uses the latest stored experimental value while preserving unrelated concurrent updates', async () => {
    using test = await fixture({ serialized: undefined, initialized: true });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    test.setStored({ experimental: { fakeLm: 'disabled', globalSearch: { scope: 'all' } } });
    const result = await test.api.saveDevelopmentMetaCspNotForSecurity({ serialized: "connect-src 'none'", isCurrent: test.api.captureStorageForDevelopmentMetaCspNotForSecurity() });
    expect(result).toBe('saved');
    expect(test.getStored()).toMatchObject({ metaCspForDevelopmentNotForSecurity: "connect-src 'none'", fakeLm: 'disabled', globalSearch: { scope: 'all' } });
    expect(test.reload).not.toHaveBeenCalled();
    expect(document.head.querySelector<HTMLMetaElement>('[data-naidan-developer-csp]')?.content).toBe("connect-src 'none'");
  });

  it('does not reload or alter the current meta when saving fails', async () => {
    using test = await fixture({ serialized: "connect-src 'none'", initialized: true });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    test.update.mockRejectedValueOnce(new Error('storage write failed'));
    expect(await test.api.clearDevelopmentMetaCspNotForSecurity()).toBe('failed');
    expect(test.api.operation.value).toBe('failed');
    expect(test.reload).not.toHaveBeenCalled();
    expect(test.getStored()?.metaCspForDevelopmentNotForSecurity).toBe("connect-src 'none'");
    expect(document.head.querySelector<HTMLMetaElement>('[data-naidan-developer-csp]')?.content).toBe("connect-src 'none'");
  });

  it('rejects a stale storage capture before saving', async () => {
    using test = await fixture({ serialized: undefined, initialized: true });
    const isCurrent = test.api.captureStorageForDevelopmentMetaCspNotForSecurity();
    test.setStorageCurrent({ current: false });
    expect(await test.api.saveDevelopmentMetaCspNotForSecurity({ serialized: "default-src 'none'", isCurrent })).toBe('changed');
    expect(test.update).not.toHaveBeenCalled();
    expect(test.reload).not.toHaveBeenCalled();
  });

  it('checks the storage again after an asynchronous save before adding a meta', async () => {
    using test = await fixture({ serialized: undefined, initialized: true });
    test.update.mockImplementationOnce(async () => {
      test.setStorageCurrent({ current: false });
      return 'saved';
    });
    expect(await test.api.saveDevelopmentMetaCspNotForSecurity({ serialized: "connect-src 'none'", isCurrent: test.api.captureStorageForDevelopmentMetaCspNotForSecurity() })).toBe('changed');
    expect(test.reload).not.toHaveBeenCalled();
  });

  it('stores only the latest value while keeping every distinct enforced addition through clear', async () => {
    using test = await fixture({ serialized: undefined, initialized: true });
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => true });
    for (const serialized of ["connect-src 'none'", 'connect-src *', "connect-src 'none'"]) {
      expect(await test.api.saveDevelopmentMetaCspNotForSecurity({ serialized, isCurrent: test.api.captureStorageForDevelopmentMetaCspNotForSecurity() })).toBe('saved');
    }
    expect(test.getStored()?.metaCspForDevelopmentNotForSecurity).toBe("connect-src 'none'");
    expect(test.api.additions.value.map(addition => addition.serialized)).toEqual(["connect-src 'none'", 'connect-src *']);
    expect(document.head.querySelectorAll('[data-naidan-developer-csp]')).toHaveLength(2);
    expect(await test.api.clearDevelopmentMetaCspNotForSecurity()).toBe('saved');
    expect(test.getStored()?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(test.api.additions.value).toHaveLength(2);
    expect(test.reload).not.toHaveBeenCalled();
  });

  it('waits for the first saved value to mount the already prepared resident button', async () => {
    using test = await fixture({ serialized: undefined, initialized: true });
    let resident = false;
    await test.api.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: () => resident });
    const stop = watch(() => test.settings.value.experimental?.metaCspForDevelopmentNotForSecurity, () => {
      resident = true;
    }, { flush: 'post' });
    using cleanup = {
      [Symbol.dispose]() {
        stop();
      },
    };
    expect(await test.api.saveDevelopmentMetaCspNotForSecurity({ serialized: "default-src 'none'", isCurrent: test.api.captureStorageForDevelopmentMetaCspNotForSecurity() })).toBe('saved');
    expect(test.api.additions.value).toHaveLength(1);
    expect(test.reload).not.toHaveBeenCalled();
  });
});
