import { describe, it, expect, vi, beforeEach } from 'vitest';
import { urlImportExportLogic } from './url-logic';

const { mockExportData, mockVerify, mockExecuteImport } = vi.hoisted(() => ({
  mockExportData: vi.fn(),
  mockVerify: vi.fn(),
  mockExecuteImport: vi.fn(),
}));

vi.mock('../storage', () => ({
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

    const data = await urlImportExportLogic.exportToBase64({});
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
      configurable: true
    });

    const url = await urlImportExportLogic.getExportURL({});
    const urlObj = new URL(url);

    expect(urlObj.hash).toContain('storage-type=local');
    expect(urlObj.hash).toContain('data-zip=');
    expect(urlObj.hash).toMatch(/^#\/\?/);

    Object.defineProperty(window, 'location', {
      value: { href: originalLocation },
      writable: true,
      configurable: true
    });
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
              'other': 'param'
            }
          }
        },
        replace: mockReplace
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
});

