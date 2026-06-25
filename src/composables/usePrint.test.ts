import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePrint } from './usePrint';

describe('usePrint composable', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      print: vi.fn(),
    });
    vi.stubGlobal('document', {
      title: 'Original Title',
    });
    vi.clearAllMocks();
  });

  it('should have initial activePrintMode as undefined', () => {
    const { activePrintMode } = usePrint();
    expect(activePrintMode.value).toBeUndefined();
  });

  it('should handle internal state via TEST_ONLY', () => {
    const { activePrintMode, TEST_ONLY } = usePrint();

    TEST_ONLY.setActivePrintMode({ mode: 'chat' });
    expect(activePrintMode.value).toBe('chat');

    TEST_ONLY.setActivePrintMode({ mode: undefined });
    expect(activePrintMode.value).toBeUndefined();
  });

  it('should coordinate readiness through waitForPrintReady and markPrintReady', async () => {
    const { markPrintReady, TEST_ONLY } = usePrint();

    let resolved = false;
    const promise = TEST_ONLY.waitForPrintReady().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    markPrintReady();
    await promise;

    expect(resolved).toBe(true);
  });

  it('should execute the full print workflow', async () => {
    const { activePrintMode, print, markPrintReady } = usePrint();
    const testTitle = 'New Print Title';

    // Start print flow
    const printPromise = print({ title: testTitle, mode: 'chat' });

    // Verify mode is set and title swapped
    expect(activePrintMode.value).toBe('chat');
    expect(document.title).toBe(testTitle);

    // Simulate component being ready
    markPrintReady();

    await printPromise;

    // Verify window.print called and state restored
    expect(window.print).toHaveBeenCalled();
    expect(activePrintMode.value).toBeUndefined();
    expect(document.title).toBe('Original Title');
  });

  it('should restore state even if an error occurs during printing', async () => {
    const { activePrintMode, print } = usePrint();

    // Force waitForPrintReady to fail (simulated by throwing in a microtask)
    vi.spyOn(document, 'title', 'set').mockImplementation(() => {
      throw new Error('Title Swap Failed');
    });

    try {
      await print({ title: 'Boom', mode: 'chat' });
    } catch (e) {
      // Expected
    }

    expect(activePrintMode.value).toBeUndefined();
    vi.restoreAllMocks();
  });
});
