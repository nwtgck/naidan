import { describe, expect, it, vi } from 'vitest';
import { createActiveHizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';

function inspector(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}

describe('active HizoFS physical inspection source', () => {
  it('snapshots the physical path and disposes the product lease', async () => {
    const mutablePath = ['stores', 'active.hizofs'];
    const dispose = vi.fn(async () => undefined);
    const expectedInspector = inspector();
    const createInspector = vi.fn(async ({ physicalPath }: { physicalPath: readonly string[] }) => {
      mutablePath[1] = 'replaced.hizofs';
      expect(physicalPath).toEqual(['stores', 'active.hizofs']);
      return expectedInspector;
    });
    const source = createActiveHizoFSPhysicalInspectionSource({
      createInspector,
      openLease: async () => ({ assertCurrent: () => undefined, dispose, physicalPath: mutablePath }),
    });

    await expect(source.open()).resolves.toBe(expectedInspector);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the product lease when Inspector construction fails', async () => {
    const dispose = vi.fn(async () => undefined);
    const source = createActiveHizoFSPhysicalInspectionSource({
      createInspector: async () => {
        throw new Error('physical path unavailable');
      },
      openLease: async () => ({ assertCurrent: () => undefined, dispose, physicalPath: ['stores', 'active.hizofs'] }),
    });

    await expect(source.open()).rejects.toThrow('physical path unavailable');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an Inspector that finishes after its provider generation is replaced', async () => {
    let current = true;
    const dispose = vi.fn(async () => undefined);
    const source = createActiveHizoFSPhysicalInspectionSource({
      createInspector: async () => {
        current = false;
        return inspector();
      },
      openLease: async () => ({
        assertCurrent() {
          if (!current) throw new Error('authenticated location replaced');
        },
        dispose,
        physicalPath: ['stores', 'active.hizofs'],
      }),
    });

    await expect(source.open()).rejects.toThrow('authenticated location replaced');
    expect(dispose).toHaveBeenCalledOnce();
  });

});
