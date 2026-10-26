import { describe, it, expect, vi, beforeEach } from 'vitest';
import { urlImportExportLogic } from './url-logic';
import type { ExportExclusions } from './types';
import { createMemoryHistory, createRouter } from 'vue-router';
import { readFirstQueryValue, resolveInitialRoute } from '@/logic/startup/startup-route';

const { mockExportData, mockVerify, mockExecuteImport } = vi.hoisted(() => ({
  mockExportData: vi.fn(),
  mockVerify: vi.fn(),
  mockExecuteImport: vi.fn(),
}));

vi.mock('../../00-storage/service', () => ({
  storageService: {
    getCurrentType: vi.fn().mockReturnValue('local'),
  },
}));

vi.mock('./service', () => {
  return {
    ImportExportService: class {
      exportData = mockExportData;
      verify = mockVerify;
      executeImport = mockExecuteImport;
    },
  };
});

function readStartupPayloadFromAnchor({ url }: { url: string }): string {
  const anchor = document.createElement('a');
  anchor.href = url;
  const history = createMemoryHistory();
  // Hash history exposes the fragment after '#'; startup resolves it once.
  history.replace(new URL(anchor.href).hash.slice(1));
  const router = createRouter({ history, routes: [{ path: '/', component: { template: '<div />' } }] });
  const route = resolveInitialRoute({ router });
  const payload = readFirstQueryValue({ value: route.query['data-zip'] });
  if (payload === undefined) {
    throw new Error('Expected the generated data-zip query');
  }
  return payload;
}

function readBlobBytes({ blob }: { blob: Blob }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('Expected binary Blob data'));
      }
    };
    reader.readAsArrayBuffer(blob);
  });
}

describe('URLImportExportLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export data to a Base64 string and return size', async () => {
    mockExportData.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('mock-zip-content'));
          controller.close();
        },
      }),
    });

    const data = await urlImportExportLogic.exportToBase64({ exclude: undefined });
    expect(typeof data.zipBase64).toBe('string');
    expect(data.size).toBe(data.zipBase64.length);
    // 'mock-zip-content' in base64 is 'bW9jay16aXAtY29udGVudA=='
    expect(atob(data.zipBase64)).toBe('mock-zip-content');
  });

  it('should generate an export URL with parameters in the hash', async () => {
    mockExportData.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data'));
          controller.close();
        },
      }),
    });

    // Mock window.location.href
    const originalLocation = window.location.href;
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost:3000/#/settings' },
      writable: true,
      configurable: true,
    });

    const url = await urlImportExportLogic.getExportURL({ exclude: undefined, baseUrl: window.location.href });
    const urlObj = new URL(url);

    expect(urlObj.hash).toContain('storage-type=local');
    expect(urlObj.hash).toContain('data-zip=');
    expect(urlObj.hash).toMatch(/^#\/\?/);

    Object.defineProperty(window, 'location', {
      value: { href: originalLocation },
      writable: true,
      configurable: true,
    });
  });

  it('should generate an export URL for an explicit base URL without requiring a hash suffix', async () => {
    mockExportData.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data'));
          controller.close();
        },
      }),
    });

    const url = await urlImportExportLogic.getExportURL({
      exclude: undefined,
      baseUrl: 'https://develop.naidan.pages.dev',
    });

    const urlObj = new URL(url);
    expect(urlObj.origin).toBe('https://develop.naidan.pages.dev');
    expect(urlObj.hash).toMatch(/^#\/\?/);
    expect(urlObj.hash).toContain('storage-type=local');
    expect(urlObj.hash).toContain('data-zip=');
  });

  it('should pass exclude option to the service', async () => {
    mockExportData.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data'));
          controller.close();
        },
      }),
    });

    const exclude: ExportExclusions = ['chat_history'];
    await urlImportExportLogic.getExportURL({ exclude, baseUrl: window.location.href });

    expect(mockExportData).toHaveBeenCalledWith(expect.objectContaining({ exclude }));
  });

  it('should import data from a Base64 string', async () => {
    const mockBase64 = btoa('incoming-data');
    mockVerify.mockResolvedValue(undefined);
    mockExecuteImport.mockResolvedValue(undefined);

    await urlImportExportLogic.importFromBase64({ zipBase64: mockBase64 });

    expect(mockVerify).toHaveBeenCalled();
    expect(mockExecuteImport).toHaveBeenCalled();
  });

  describe('URL Parameter Management (Simulation of main.ts logic)', () => {
    it('should remove data-zip from query params while keeping storage-type', () => {
      const mockReplace = vi.fn();
      const mockRouter = {
        currentRoute: {
          value: {
            query: {
              'storage-type': 'opfs',
              'data-zip': 'large-base64-string',
              'other': 'param',
            },
          },
        },
        replace: mockReplace,
      };

      // The logic from main.ts
      const dataZipQuery = mockRouter.currentRoute.value.query['data-zip'];
      const dataZipBase64 = Array.isArray(dataZipQuery) ? dataZipQuery[0] : dataZipQuery;

      if (dataZipBase64) {
        const newQuery: Partial<Record<string, any>> = { ...mockRouter.currentRoute.value.query };
        delete newQuery['data-zip'];
        mockRouter.replace({ query: newQuery });
      }

      expect(mockReplace).toHaveBeenCalled();
      const firstCall = mockReplace.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall![0].query).not.toHaveProperty('data-zip');
      expect(firstCall![0].query).toHaveProperty('storage-type', 'opfs');
    });
  });

  describe('binary payload transport through the startup router', () => {
    beforeEach(() => {
      mockExportData.mockReset();
      mockVerify.mockReset().mockResolvedValue(undefined);
      mockExecuteImport.mockReset().mockResolvedValue(undefined);
    });

    it('roundtrips every byte through generated URL, anchor, startup query parsing and atob', async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      mockExportData.mockResolvedValue({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 127));
            controller.enqueue(bytes.slice(127));
            controller.close();
          },
        }),
      });
      const url = await urlImportExportLogic.getExportURL({ exclude: [], baseUrl: 'https://naidan.pages.dev/' });
      const payload = readStartupPayloadFromAnchor({ url });
      const expected = btoa(String.fromCharCode(...bytes));
      expect(expected).toContain('+');
      expect(expected).toContain('/');
      expect(expected).toContain('=');
      expect(url).toContain('%2B');
      expect(url).toContain('%2F');
      expect(url).toContain('%3D');
      expect(payload).toBe(expected);
      await urlImportExportLogic.importFromBase64({ zipBase64: payload });
      expect(mockVerify).toHaveBeenCalledOnce();
      expect(mockExecuteImport).toHaveBeenCalledOnce();
      const importedBlob: Blob = mockVerify.mock.calls[0]?.[0].zipFile;
      expect(await readBlobBytes({ blob: importedBlob })).toEqual(bytes);
    });

    it('preserves an encoded plus, slash and padding without a second query decoding step', async () => {
      const bytes = Uint8Array.of(0xfb, 0xff);
      mockExportData.mockResolvedValue({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
      const url = await urlImportExportLogic.getExportURL({ exclude: ['chat', 'binary_object'], baseUrl: 'https://naidan-curated.pages.dev/' });
      expect(new URL(url).hash).toContain('data-zip=%2B%2F8%3D');
      const payload = readStartupPayloadFromAnchor({ url });
      expect(payload).toBe('+/8=');
      await urlImportExportLogic.importFromBase64({ zipBase64: payload });
      expect(mockVerify).toHaveBeenCalledOnce();
      const importedBlob: Blob = mockVerify.mock.calls[0]?.[0].zipFile;
      expect(await readBlobBytes({ blob: importedBlob })).toEqual(bytes);
    });

    it.each([
      { corruption: 'raw plus', encodedPayload: '+%2F8%3D', parsedPayload: ' /8=' },
      { corruption: 'double percent encoding', encodedPayload: '%252B%252F8%253D', parsedPayload: '%2B%2F8%3D' },
      { corruption: 'truncation to a one-character remainder', encodedPayload: 'A', parsedPayload: 'A' },
    ])('rejects $corruption before ZIP verification', async ({ encodedPayload, parsedPayload }) => {
      const payload = readStartupPayloadFromAnchor({ url: `https://naidan.pages.dev/#/?storage-type=local&data-zip=${encodedPayload}` });
      expect(payload).toBe(parsedPayload);
      await expect(urlImportExportLogic.importFromBase64({ zipBase64: payload })).rejects.toMatchObject({ name: 'InvalidCharacterError' });
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockExecuteImport).not.toHaveBeenCalled();
    });
  });
});
