import { describe, expect, it, vi } from 'vitest';
import { reuseDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision';
import type { DownloadVerificationCachedRevisionInventory } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';

const REVISION = '1'.repeat(40);

function inventory(): DownloadVerificationCachedRevisionInventory {
  return {
    modelId: 'org/model',
    normalizedModelId: 'org/model',
    revisions: [{
      revision: REVISION,
      kind: 'immutable-sha',
      totalBytes: 100,
      fileCount: 2,
      completionMarkerCount: 2,
      incompleteFileCount: 0,
      zeroByteFileCount: 0,
      weightFileCount: 1,
      lastModified: 1,
      status: 'committed-file-set',
    }],
  };
}

describe('reuseDownloadedProductionRevision', () => {
  it('returns the accepted Production cache revision without downloading', async () => {
    const acceptReusableRevisions = vi.fn(async () => ({
      status: 'accepted' as const,
      selectedRevision: { revision: REVISION, loaderRevisionOption: REVISION, source: 'current-resolved-revision' as const },
      attempts: [],
      error: undefined,
    }));

    const result = await reuseDownloadedProductionRevision({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      storageRoot: {} as FileSystemDirectoryHandle,
      inspectCachedRevisions: vi.fn(async () => inventory()),
      acceptReusableRevisions,
    });

    expect(result).toMatchObject({ reused: true, loadRevision: REVISION });
    expect(acceptReusableRevisions).toHaveBeenCalledTimes(1);
  });

  it('returns not reused when no committed revision is eligible', async () => {
    const empty = { ...inventory(), revisions: [] };
    const acceptReusableRevisions = vi.fn();

    const result = await reuseDownloadedProductionRevision({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      storageRoot: {} as FileSystemDirectoryHandle,
      inspectCachedRevisions: vi.fn(async () => empty),
      acceptReusableRevisions,
    });

    expect(result).toEqual({ reused: false, acceptance: undefined });
    expect(acceptReusableRevisions).not.toHaveBeenCalled();
  });

  it('fails closed when a committed cache is runtime rejected', async () => {
    await expect(reuseDownloadedProductionRevision({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      storageRoot: {} as FileSystemDirectoryHandle,
      inspectCachedRevisions: vi.fn(async () => inventory()),
      acceptReusableRevisions: vi.fn(async () => ({
        status: 'exhausted' as const,
        selectedRevision: undefined,
        attempts: [{
          candidate: { revision: REVISION, loaderRevisionOption: REVISION, source: 'current-resolved-revision' as const },
          acceptance: {
            modelId: 'org/model',
            repositoryResolvedRevision: REVISION,
            cacheRevision: REVISION,
            loaderRevisionOption: REVISION,
            status: 'rejected' as const,
            selectedDevice: undefined,
            selectedDtype: undefined,
            observationMethod: 'production-cache-only-revision-runtime-preparation' as const,
            error: { name: 'RuntimeRejected', message: 'ORT rejected cached artifacts' },
          },
        }],
        error: undefined,
      })),
    })).rejects.toThrow('RuntimeRejected: ORT rejected cached artifacts');
  });

  it('fails closed when the cache inventory cannot be inspected safely', async () => {
    await expect(reuseDownloadedProductionRevision({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      storageRoot: {} as FileSystemDirectoryHandle,
      inspectCachedRevisions: vi.fn(async () => {
        throw new Error('OPFS unavailable');
      }),
      acceptReusableRevisions: vi.fn(),
    })).rejects.toThrow('CachedRevisionInspectionFailed');
  });
});
