import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPersistenceControlInspectionSource,
  TEST_ONLY,
  usePersistenceControlInspector,
} from '@/features/debug-opfs-encryption/composables/usePersistenceControlInspector';
import type { PersistenceControlInspectionSource } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';

function source(): PersistenceControlInspectionSource {
  return { inspectPersistenceControl: vi.fn(async () => {
    throw new Error('not called');
  }) };
}

beforeEach(() => {
  TEST_ONLY.reset();
});

describe('Persistence Control Inspector source composition', () => {
  it('does not let stale provider cleanup remove a newer source', () => {
    const first = source();
    const second = source();
    const disposeFirst = installPersistenceControlInspectionSource({ source: first });
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBe(first);

    const disposeSecond = installPersistenceControlInspectionSource({ source: second });
    disposeFirst();
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBe(second);

    disposeSecond();
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBeUndefined();
  });

  it('loads the native audit source only when the Inspector opens', async () => {
    const nativeSource = source();
    const createSource = vi.fn(() => nativeSource);
    const loadSource = vi.fn(async () => ({
      createNativeOpfsPersistenceControlInspectionSource: createSource,
    }));
    const inspector = usePersistenceControlInspector();

    expect(inspector.isPersistenceControlInspectorOpen.value).toBe(false);
    expect(loadSource).not.toHaveBeenCalled();

    await TEST_ONLY.ensureDefaultPersistenceControlInspectionSourceWith({ loadSource });
    expect(loadSource).toHaveBeenCalledOnce();
    expect(createSource).toHaveBeenCalledOnce();
    expect(inspector.persistenceControlInspectionSource.value).toBe(nativeSource);
  });

  it('opens after the default audit source is available', async () => {
    const inspector = usePersistenceControlInspector();

    await inspector.openPersistenceControlInspector();

    expect(inspector.isPersistenceControlInspectorOpen.value).toBe(true);
    expect(inspector.persistenceControlInspectionSource.value).toBeDefined();
  });

  it('keeps the Inspector closed when lazy source loading fails and permits retry', async () => {
    const nativeSource = source();
    const failure = new Error('Inspector chunk unavailable');
    const loadSource = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        createNativeOpfsPersistenceControlInspectionSource: () => nativeSource,
      });

    await expect(TEST_ONLY.ensureDefaultPersistenceControlInspectionSourceWith({ loadSource }))
      .rejects.toBe(failure);
    expect(usePersistenceControlInspector().isPersistenceControlInspectorOpen.value).toBe(false);

    await TEST_ONLY.ensureDefaultPersistenceControlInspectionSourceWith({ loadSource });
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBe(nativeSource);
    expect(loadSource).toHaveBeenCalledTimes(2);
  });
});
