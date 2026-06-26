import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSysfsNaidanBinaryObjectDataFilePath,
  buildWikipediaBinaryObjectName,
  countLines,
  saveWikipediaPageTextAsBinaryObject,
  WIKIPEDIA_INLINE_CONTENT_MAX_LINES,
} from './binary-object';
import { toBinaryObjectId } from '@/models/ids';

const { mockSaveFile, mockGenerateId } = vi.hoisted(() => ({
  mockSaveFile: vi.fn(),
  mockGenerateId: vi.fn(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    saveFile: mockSaveFile,
  },
}));

vi.mock('@/utils/id', () => ({
  generateId: mockGenerateId,
}));

describe('countLines', () => {
  it('returns 0 for empty text', () => {
    expect(countLines({ text: '' })).toBe(0);
  });

  it('counts lines without splitting', () => {
    expect(countLines({ text: `\
a
b
c` })).toBe(3);
    expect(countLines({ text: `\
a\\r
b\\r
c` })).toBe(3);
  });
});

describe('buildWikipediaBinaryObjectName', () => {
  it('includes title, lang, and pageId', () => {
    expect(buildWikipediaBinaryObjectName({
      title: 'Quantum computing',
      lang: 'en',
      pageId: 25220,
    })).toBe('Quantum_computing_en_25220.txt');
  });

  it('keeps Japanese titles', () => {
    expect(buildWikipediaBinaryObjectName({
      title: '量子コンピュータ',
      lang: 'ja',
      pageId: 894134,
    })).toBe('量子コンピュータ_ja_894134.txt');
  });

  it('sanitizes unsafe filename characters', () => {
    expect(buildWikipediaBinaryObjectName({
      title: 'A/B:C*D?E"F<G>H| I',
      lang: 'en',
      pageId: 1,
    })).toBe('A_B_C_D_E_F_G_H_I_en_1.txt');
  });
});

describe('buildSysfsNaidanBinaryObjectDataFilePath', () => {
  it('builds the sysfs data path from the mount path', () => {
    expect(buildSysfsNaidanBinaryObjectDataFilePath({
      binaryObjectId: toBinaryObjectId({ raw: 'bin-1' }),
    })).toBe('/sys/fs/naidan/binary-objects/by-id/bin-1/data');
  });
});

describe('saveWikipediaPageTextAsBinaryObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateId.mockReturnValue('bin-1');
  });

  it('saves a text blob once and returns its sysfs path, line count, and byte length', async () => {
    const content = `\
line 1
line 2`;
    const lineCount = countLines({ text: content });

    const result = await saveWikipediaPageTextAsBinaryObject({
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content,
      lineCount,
    });

    expect(mockSaveFile).toHaveBeenCalledTimes(1);
    const saveFileParams = mockSaveFile.mock.calls[0]?.[0] as {
      blob: Blob,
      binaryObjectId: string,
      name: string,
    };
    expect(saveFileParams.blob.type).toBe('text/plain;charset=utf-8');
    expect(saveFileParams.blob.size).toBe(result.byteLength);
    expect(mockSaveFile).toHaveBeenCalledWith({
      blob: saveFileParams.blob,
      binaryObjectId: 'bin-1',
      name: 'Quantum_computing_en_25220.txt',
    });
    expect(result).toEqual({
      lineCount: 2,
      byteLength: saveFileParams.blob.size,
      sysfsNaidanDataFilePath: '/sys/fs/naidan/binary-objects/by-id/bin-1/data',
    });
  });

  it('works with content above the inline threshold', async () => {
    const content = `${'x\n'.repeat(WIKIPEDIA_INLINE_CONTENT_MAX_LINES)}overflow`;
    const lineCount = countLines({ text: content });

    const result = await saveWikipediaPageTextAsBinaryObject({
      lang: 'ja',
      pageId: 894134,
      title: '量子コンピュータ',
      content,
      lineCount,
    });

    expect(result.lineCount).toBe(WIKIPEDIA_INLINE_CONTENT_MAX_LINES + 1);
    expect(result.byteLength).toBe((mockSaveFile.mock.calls[0]?.[0] as { blob: Blob }).blob.size);
  });
});
