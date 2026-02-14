import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkOPFSSupport } from './opfs-detection';

describe('checkOPFSSupport', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return true if getDirectory and createWritable are supported', async () => {
    const mockFileHandle = {
      createWritable: vi.fn()
    };
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined)
    };
    (navigator.storage.getDirectory as any).mockResolvedValue(mockDirectoryHandle);

    const result = await checkOPFSSupport();
    expect(result).toBe(true);
    expect(mockDirectoryHandle.getFileHandle).toHaveBeenCalled();
  });

  it('should return false if getDirectory is missing', async () => {
    vi.stubGlobal('navigator', {
      storage: {},
    });
    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should return false if navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {});
    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should return false if getDirectory throws an error', async () => {
    (navigator.storage.getDirectory as any).mockRejectedValue(new Error('Security Error'));
    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should return false if getDirectory succeeds but createWritable is missing (Safari scenario)', async () => {
    const mockFileHandle = {}; // Missing createWritable
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined)
    };
    (navigator.storage.getDirectory as any).mockResolvedValue(mockDirectoryHandle);

    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should return false if getFileHandle fails', async () => {
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockRejectedValue(new Error('Quota exceeded')),
      removeEntry: vi.fn()
    };
    (navigator.storage.getDirectory as any).mockResolvedValue(mockDirectoryHandle);

    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should return false if navigator is undefined (SSR)', async () => {
    vi.stubGlobal('navigator', undefined);
    const result = await checkOPFSSupport();
    expect(result).toBe(false);
  });

  it('should not depend on window.isSecureContext (pure capability detection)', async () => {
    let accessed = false;
    // Define a property with a getter to track access
    Object.defineProperty(globalThis, 'isSecureContext', {
      get() {
        accessed = true;
        return false; // Return false to see if it blocks the detection
      },
      configurable: true
    });

    const mockFileHandle = {
      createWritable: vi.fn()
    };
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined)
    };
    (navigator.storage.getDirectory as any).mockResolvedValue(mockDirectoryHandle);

    const result = await checkOPFSSupport();

    // It should return true because getDirectory() succeeded,
    // and it should NOT have accessed isSecureContext.
    expect(result).toBe(true);
    expect(accessed).toBe(false);

    // Clean up the property
    delete (globalThis as any).isSecureContext;
  });
});