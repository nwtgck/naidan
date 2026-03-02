import { describe, it, expect, vi, beforeEach } from 'vitest';
import { printElement } from './print';

const mockSetActivePrintMode = vi.fn();
const mockWaitForPrintReady = vi.fn();
const mockMarkPrintReady = vi.fn();

vi.mock('../composables/usePrint', () => ({
  usePrint: () => ({
    activePrintMode: { value: undefined },
    setActivePrintMode: mockSetActivePrintMode,
    waitForPrintReady: mockWaitForPrintReady,
    markPrintReady: mockMarkPrintReady,
  })
}));

describe('print utility', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      print: vi.fn(),
    });
    // Stub document.title
    vi.stubGlobal('document', {
      title: 'Old Title'
    });
    vi.clearAllMocks();

    // Default mock behavior
    mockWaitForPrintReady.mockResolvedValue(undefined);
  });

  it('should trigger the full print sequence', async () => {
    const title = 'Test Print Title';
    const mode = 'chat';

    // Create a promise that we can control
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    mockWaitForPrintReady.mockReturnValue(readyPromise);

    // Start printing flow
    const printPromise = printElement({ title, mode });

    // Ensure mode is set and title updated
    expect(mockSetActivePrintMode).toHaveBeenCalledWith({ mode });
    expect(document.title).toBe(title);

    // Simulate PrintView becoming ready
    resolveReady!();

    await printPromise;

    // Ensure window.print was called
    expect(window.print).toHaveBeenCalled();

    // Ensure mode is reset and title restored
    expect(mockSetActivePrintMode).toHaveBeenLastCalledWith({ mode: undefined });
    expect(document.title).toBe('Old Title');
  });

  it('should use current document title if none provided', async () => {
    mockWaitForPrintReady.mockResolvedValue(undefined);

    await printElement({ title: undefined, mode: 'chat' });

    expect(document.title).toBe('Old Title');
    expect(window.print).toHaveBeenCalled();
    expect(mockSetActivePrintMode).toHaveBeenLastCalledWith({ mode: undefined });
  });
});
