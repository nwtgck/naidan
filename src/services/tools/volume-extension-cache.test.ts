import { describe, it, expect, beforeEach } from 'vitest';
import {
  startVolumeExtensionScan,
  abortOngoingScans,
  getVolumeExtensions,
  isVolumeScanned,
  __testOnly,
} from './volume-extension-cache';

function makeFileHandle(name: string): FileSystemFileHandle {
  return { kind: 'file', name } as FileSystemFileHandle;
}

function makeDirHandle(
  name: string,
  children: [string, FileSystemHandle][],
): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    entries: async function* () {
      for (const entry of children) yield entry;
    },
  } as unknown as FileSystemDirectoryHandle;
}

beforeEach(() => {
  __testOnly.reset();
});

describe('getVolumeExtensions', () => {
  it('returns an empty set for an unknown volumeId', () => {
    expect(getVolumeExtensions({ volumeId: 'unknown' }).size).toBe(0);
  });
});

describe('isVolumeScanned', () => {
  it('returns false before a scan starts', () => {
    expect(isVolumeScanned({ volumeId: 'vol-x' })).toBe(false);
  });

  it('returns true once a scan has been started for the volume', async () => {
    const handle = makeDirHandle('root', []);
    startVolumeExtensionScan({ volumeId: 'vol-x', handle });
    await __testOnly.scanPromises.get('vol-x');
    expect(isVolumeScanned({ volumeId: 'vol-x' })).toBe(true);
  });
});

describe('startVolumeExtensionScan', () => {
  it('collects file extensions from a flat directory', async () => {
    const handle = makeDirHandle('root', [
      ['report.docx', makeFileHandle('report.docx')],
      ['data.xlsx', makeFileHandle('data.xlsx')],
      ['notes.txt', makeFileHandle('notes.txt')],
    ]);

    startVolumeExtensionScan({ volumeId: 'vol-flat', handle });
    await __testOnly.scanPromises.get('vol-flat');

    const exts = getVolumeExtensions({ volumeId: 'vol-flat' });
    expect(exts.has('.docx')).toBe(true);
    expect(exts.has('.xlsx')).toBe(true);
    expect(exts.has('.txt')).toBe(true);
  });

  it('recurses into subdirectories', async () => {
    const deep = makeDirHandle('deep', [['slide.pptx', makeFileHandle('slide.pptx')]]);
    const sub = makeDirHandle('sub', [['deep', deep]]);
    const handle = makeDirHandle('root', [['sub', sub]]);

    startVolumeExtensionScan({ volumeId: 'vol-deep', handle });
    await __testOnly.scanPromises.get('vol-deep');

    expect(getVolumeExtensions({ volumeId: 'vol-deep' }).has('.pptx')).toBe(true);
  });

  it('normalises extensions to lowercase', async () => {
    const handle = makeDirHandle('root', [
      ['REPORT.DOCX', makeFileHandle('REPORT.DOCX')],
    ]);

    startVolumeExtensionScan({ volumeId: 'vol-case', handle });
    await __testOnly.scanPromises.get('vol-case');

    expect(getVolumeExtensions({ volumeId: 'vol-case' }).has('.docx')).toBe(true);
  });

  it('replaces an ongoing scan for the same volumeId when called again', async () => {
    // First scan: never resolves (the abort from the second scan will unblock it)
    const neverHandle = {
      kind: 'directory',
      name: 'root',
      entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<IteratorResult<[string, FileSystemHandle]>> {
            await new Promise(() => {}); // blocks forever
            return { done: true, value: undefined as never };
          },
        };
      },
    } as unknown as FileSystemDirectoryHandle;

    startVolumeExtensionScan({ volumeId: 'vol-replace', handle: neverHandle });

    // Second scan: fast, with a real file — replaces (and aborts) the first
    const fastHandle = makeDirHandle('root', [['data.xlsx', makeFileHandle('data.xlsx')]]);
    startVolumeExtensionScan({ volumeId: 'vol-replace', handle: fastHandle });

    await __testOnly.scanPromises.get('vol-replace');

    expect(getVolumeExtensions({ volumeId: 'vol-replace' }).has('.xlsx')).toBe(true);
  });
});

describe('abortOngoingScans', () => {
  it('prevents extensions from being collected after abort', async () => {
    const handle = {
      kind: 'directory',
      name: 'root',
      entries: async function* () {
        await new Promise(resolve => setTimeout(resolve, 50));
        yield ['file.docx', makeFileHandle('file.docx')] as [string, FileSystemHandle];
      },
    } as unknown as FileSystemDirectoryHandle;

    startVolumeExtensionScan({ volumeId: 'vol-abort', handle });
    abortOngoingScans();

    // Await the scan promise — it should resolve quickly after abort
    await __testOnly.scanPromises.get('vol-abort');

    // Signal was aborted before the file entry could be recorded
    expect(getVolumeExtensions({ volumeId: 'vol-abort' }).size).toBe(0);
  });
});
