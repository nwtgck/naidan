import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installHizoFSPhysicalInspectionSource,
  TEST_ONLY,
  useDebugHizoFSWorkbench,
} from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';

function source(): HizoFSPhysicalInspectionSource {
  return { open: vi.fn(async () => {
    throw new Error('not called');
  }) };
}

beforeEach(() => {
  TEST_ONLY.reset();
});

describe('HizoFS Workbench source composition', () => {
  it('does not let stale provider cleanup remove a newer source', () => {
    const first = source();
    const second = source();
    const disposeFirst = installHizoFSPhysicalInspectionSource({ source: first });
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(first);

    const disposeSecond = installHizoFSPhysicalInspectionSource({ source: second });
    disposeFirst();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(second);

    disposeSecond();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBeUndefined();
  });

  it('loads the active location and physical Inspector only when requested', async () => {
    const physicalSource = source();
    const openLease = vi.fn(async () => {
      throw new Error('not called');
    });
    const createSource = vi.fn(() => physicalSource);
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSContainerLocationLease: openLease,
    }));
    const loadInspectionSource = vi.fn(async () => ({
      createActiveHizoFSPhysicalInspectionSource: createSource,
    }));

    await TEST_ONLY.ensureDefaultHizoFSPhysicalInspectionSourceWith({
      loadActiveLocation,
      loadInspectionSource,
    });

    expect(loadActiveLocation).toHaveBeenCalledOnce();
    expect(loadInspectionSource).toHaveBeenCalledOnce();
    expect(createSource).toHaveBeenCalledWith({ openLease });
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(physicalSource);
  });

  it('opens after the default physical source is available', async () => {
    const workbench = useDebugHizoFSWorkbench();

    await workbench.openDebugHizoFSWorkbench();

    expect(workbench.isDebugHizoFSWorkbenchOpen.value).toBe(true);
    expect(workbench.physicalInspectionSource.value).toBeDefined();
  });

  it('does not load a default source when a provider source is already installed', async () => {
    const providerSource = source();
    installHizoFSPhysicalInspectionSource({ source: providerSource });
    const loadActiveLocation = vi.fn();
    const loadInspectionSource = vi.fn();

    await TEST_ONLY.ensureDefaultHizoFSPhysicalInspectionSourceWith({
      loadActiveLocation,
      loadInspectionSource,
    });

    expect(loadActiveLocation).not.toHaveBeenCalled();
    expect(loadInspectionSource).not.toHaveBeenCalled();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(providerSource);
  });
});
