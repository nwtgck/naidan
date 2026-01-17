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

  it('should return true if getDirectory succeeds', async () => {
    (navigator.storage.getDirectory as any).mockResolvedValue({});
    const result = await checkOPFSSupport();
    expect(result).toBe(true);
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

    (navigator.storage.getDirectory as any).mockResolvedValue({});
    
    const result = await checkOPFSSupport();
    
    // It should return true because getDirectory() succeeded, 
    // and it should NOT have accessed isSecureContext.
    expect(result).toBe(true);
    expect(accessed).toBe(false);

    // Clean up the property
    delete (globalThis as any).isSecureContext;
  });
});
