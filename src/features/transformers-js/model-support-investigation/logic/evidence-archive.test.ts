// @vitest-environment node
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvidenceArchive, createEvidenceFilesReader, openEvidenceArchive, setEvidenceFile } from './evidence-archive';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Evidence transport must not fetch resources');
  }));
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('Evidence transport over the shared streaming ZIP core', () => {
  it('refuses the ZIP64 entry-count marker before reading or compressing any retained file', async () => {
    const body = new Blob(['retained']);
    const files = new Map(Array.from({ length: 65535 }, (_, index) => [`entry-${index}.bin`, body] as const));
    const read = vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
      throw new Error('File bodies must remain untouched on admission failure');
    });
    await expect(createEvidenceArchive({ files })).rejects.toThrow('Evidence archive exceeds the supported entry count');
    expect(read).not.toHaveBeenCalled();
    expect(files.size).toBe(65535);
    expect(files.get('entry-65534.bin')).toBe(body);
  });

  it('admits the entry count immediately below the ZIP64 marker', async () => {
    const body = new Blob(['retained']);
    const files = new Map(Array.from({ length: 65534 }, (_, index) => [`entry-${index}.bin`, body] as const));
    // Observe admission only: do not spend the test compressing 65k files.
    // Actual archive encoding and independent decoding are tested below.
    const boundary = new Error('Admitted first file stream');
    const read = vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
      throw boundary;
    });
    await expect(createEvidenceArchive({ files })).rejects.toBe(boundary);
    expect(read).toHaveBeenCalledOnce();
  });

  it('writes exact immutable files readable by an independent development-only ZIP implementation', async () => {
    const files = new Map<string, Blob>();
    const source = Uint8Array.of(1, 2, 3);
    setEvidenceFile({ files, path: 'run.json', content: '{"runId":"synthetic"}\n' });
    setEvidenceFile({ files, path: 'native/000001.bin', content: source });
    source.fill(9);
    const blob = await createEvidenceArchive({ files });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(archive.files).sort()).toEqual(['native/000001.bin', 'run.json']);
    expect(await archive.file('run.json')!.async('text')).toBe('{"runId":"synthetic"}\n');
    expect(await archive.file('native/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(1, 2, 3));
    expect(new Uint8Array(await (await createEvidenceArchive({ files })).arrayBuffer())).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it('indexes an independently produced ZIP and reads entries without requiring FileReader', async () => {
    const source = new JSZip();
    source.file('nested/text.txt', 'Evidence text.');
    source.file('nested/bytes.bin', Uint8Array.of(5, 6));
    const archive = await openEvidenceArchive({ blob: new Blob([await source.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })]) });
    try {
      expect(archive.reader.paths).toEqual(['nested/text.txt', 'nested/bytes.bin']);
      expect(await (await archive.reader.read({ path: 'nested/text.txt' }))!.text()).toBe('Evidence text.');
      expect(new Uint8Array(await (await archive.reader.read({ path: 'nested/bytes.bin' }))!.arrayBuffer())).toEqual(Uint8Array.of(5, 6));
      expect(await archive.reader.read({ path: 'missing' })).toBeUndefined();
    } finally {
      await archive.close();
    }
    await expect(archive.reader.read({ path: 'nested/text.txt' })).rejects.toThrow('Evidence archive reader is closed');
  });

  it('rejects corrupted stored bytes through the shared reader CRC validation', async () => {
    const source = new JSZip();
    source.file('bytes.bin', Uint8Array.of(10, 20, 30));
    const buffer = await source.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
    const bytes = new Uint8Array(buffer);
    const header = new DataView(buffer);
    const bodyOffset = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    expect(bytes.slice(bodyOffset, bodyOffset + 3)).toEqual(Uint8Array.of(10, 20, 30));
    bytes[bodyOffset] = 99;
    const archive = await openEvidenceArchive({ blob: new Blob([buffer]) });
    try {
      await expect(archive.reader.read({ path: 'bytes.bin' })).rejects.toThrow('ZIP entry CRC mismatch: bytes.bin');
    } finally {
      await archive.close();
    }
  });

  it('keeps the uncompressed verification file set independent of later map changes', async () => {
    const files = new Map<string, Blob>();
    setEvidenceFile({ files, path: 'run.json', content: 'original' });
    const reader = createEvidenceFilesReader({ files });
    setEvidenceFile({ files, path: 'run.json', content: 'replacement' });
    setEvidenceFile({ files, path: 'later.json', content: 'later' });
    expect(reader.paths).toEqual(['run.json']);
    expect(await (await reader.read({ path: 'run.json' }))!.text()).toBe('original');
    expect(await reader.read({ path: 'later.json' })).toBeUndefined();
  });

  it.each(['', '/absolute', '../outside', 'nested/../outside', 'nested\\file', 'nested//file'])('rejects noncanonical output path %j', path => {
    expect(() => setEvidenceFile({ files: new Map(), path, content: 'unused' })).toThrow('Invalid Evidence archive path');
  });
});
