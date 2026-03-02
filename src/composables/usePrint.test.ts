import { describe, it, expect } from 'vitest';
import { usePrint } from './usePrint';

describe('usePrint composable', () => {
  it('should have initial activePrintMode as undefined', () => {
    const { activePrintMode } = usePrint();
    expect(activePrintMode.value).toBeUndefined();
  });

  it('should set and clear activePrintMode', () => {
    const { activePrintMode, setActivePrintMode } = usePrint();

    setActivePrintMode({ mode: 'chat' });
    expect(activePrintMode.value).toBe('chat');

    setActivePrintMode({ mode: undefined });
    expect(activePrintMode.value).toBeUndefined();
  });

  it('should coordinate readiness through waitForPrintReady and markPrintReady', async () => {
    const { waitForPrintReady, markPrintReady } = usePrint();

    let resolved = false;
    const promise = waitForPrintReady().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    markPrintReady();
    await promise;

    expect(resolved).toBe(true);
  });
});
