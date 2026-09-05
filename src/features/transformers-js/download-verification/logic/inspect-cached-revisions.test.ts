import { describe, expect, it } from 'vitest';
import {
  inspectDownloadVerificationCachedRevisions,
  planDownloadVerificationCachedRevisionLoadCandidates,
} from './inspect-cached-revisions';

type FakeEntry = FakeDirectory | FakeFile;
interface FakeDirectory { kind: 'directory'; entries: Record<string, FakeEntry> }
interface FakeFile { kind: 'file'; size: number; lastModified: number }

function file({ size = 1, lastModified = 1 }: { size?: number; lastModified?: number } = {}): FakeFile {
  return { kind: 'file', size, lastModified };
}

function directory(entries: Record<string, FakeEntry> = {}): FakeDirectory {
  return { kind: 'directory', entries };
}

function asDirectoryHandle(value: FakeDirectory): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'fixture',
    async getDirectoryHandle(name: string) {
      const entry = value.entries[name];
      if (entry?.kind !== 'directory') throw new DOMException('Not found', 'NotFoundError');
      return asDirectoryHandle(entry);
    },
    async *entries() {
      for (const [name, entry] of Object.entries(value.entries)) {
        if (entry.kind === 'directory') {
          yield [name, asDirectoryHandle(entry)] as [string, FileSystemDirectoryHandle];
        } else {
          yield [name, {
            kind: 'file',
            name,
            async getFile() {
              return { size: entry.size, lastModified: entry.lastModified } as File;
            },
          } as FileSystemFileHandle] as [string, FileSystemFileHandle];
        }
      }
    },
  } as FileSystemDirectoryHandle;
}

function revisionDirectory({
  complete = true,
  weightSize = 100,
  lastModified = 1,
}: {
  complete?: boolean;
  weightSize?: number;
  lastModified?: number;
} = {}): FakeDirectory {
  return directory({
    'config.json': file({ size: 10, lastModified }),
    '.config.json.complete': file(),
    onnx: directory({
      'model_q4.onnx': file({ size: weightSize, lastModified }),
      ...(complete ? { '.model_q4.onnx.complete': file() } : {}),
    }),
  });
}

function storageRoot({ revisions }: { revisions: Record<string, FakeDirectory> }): FileSystemDirectoryHandle {
  return asDirectoryHandle(directory({
    models: directory({
      'huggingface.co': directory({
        org: directory({
          repo: directory({
            resolve: directory(revisions),
          }),
        }),
      }),
    }),
  }));
}

describe('inspectDownloadVerificationCachedRevisions', () => {
  it('separates legacy main and immutable SHA namespaces without calling either one model-complete', async () => {
    const sha = 'a'.repeat(40);
    const inventory = await inspectDownloadVerificationCachedRevisions({
      modelId: 'hf.co/org/repo',
      storageRoot: storageRoot({ revisions: {
        main: revisionDirectory({ lastModified: 10 }),
        [sha]: revisionDirectory({ lastModified: 20 }),
      } }),
    });

    expect(inventory.normalizedModelId).toBe('org/repo');
    expect(inventory.revisions).toEqual([
      expect.objectContaining({ revision: sha, kind: 'immutable-sha', status: 'committed-file-set' }),
      expect.objectContaining({ revision: 'main', kind: 'legacy-main', status: 'committed-file-set' }),
    ]);
  });

  it('marks a revision partial when an existing weight lacks its completion marker', async () => {
    const sha = 'b'.repeat(40);
    const inventory = await inspectDownloadVerificationCachedRevisions({
      modelId: 'org/repo',
      storageRoot: storageRoot({ revisions: { [sha]: revisionDirectory({ complete: false }) } }),
    });

    expect(inventory.revisions[0]).toEqual(expect.objectContaining({
      revision: sha,
      status: 'partial',
      incompleteFileCount: 1,
      weightFileCount: 1,
    }));
  });
});

describe('planDownloadVerificationCachedRevisionLoadCandidates', () => {
  it('uses the exact current immutable revision first and legacy main second when current SHA is known', async () => {
    const current = 'c'.repeat(40);
    const stale = 'd'.repeat(40);
    const inventory = await inspectDownloadVerificationCachedRevisions({
      modelId: 'org/repo',
      storageRoot: storageRoot({ revisions: {
        main: revisionDirectory({ lastModified: 30 }),
        [stale]: revisionDirectory({ lastModified: 40 }),
        [current]: revisionDirectory({ lastModified: 20 }),
      } }),
    });

    expect(planDownloadVerificationCachedRevisionLoadCandidates({ inventory, resolvedRevision: current })).toEqual([
      { revision: current, loaderRevisionOption: current, source: 'current-resolved-revision' },
      { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' },
    ]);
  });

  it('does not silently substitute another immutable SHA when the current resolved SHA is known but absent', async () => {
    const inventory = await inspectDownloadVerificationCachedRevisions({
      modelId: 'org/repo',
      storageRoot: storageRoot({ revisions: {
        ['e'.repeat(40)]: revisionDirectory({ lastModified: 50 }),
      } }),
    });

    expect(planDownloadVerificationCachedRevisionLoadCandidates({
      inventory,
      resolvedRevision: 'f'.repeat(40),
    })).toEqual([]);
  });

  it('uses legacy main first and then immutable SHAs by newest file timestamp when offline', async () => {
    const older = '1'.repeat(40);
    const newer = '2'.repeat(40);
    const partialNewest = '3'.repeat(40);
    const inventory = await inspectDownloadVerificationCachedRevisions({
      modelId: 'org/repo',
      storageRoot: storageRoot({ revisions: {
        main: revisionDirectory({ lastModified: 5 }),
        [older]: revisionDirectory({ lastModified: 10 }),
        [newer]: revisionDirectory({ lastModified: 20 }),
        [partialNewest]: revisionDirectory({ complete: false, lastModified: 30 }),
      } }),
    });

    expect(planDownloadVerificationCachedRevisionLoadCandidates({ inventory, resolvedRevision: undefined })).toEqual([
      { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' },
      { revision: newer, loaderRevisionOption: newer, source: 'offline-immutable-fallback' },
      { revision: older, loaderRevisionOption: older, source: 'offline-immutable-fallback' },
    ]);
  });
});
