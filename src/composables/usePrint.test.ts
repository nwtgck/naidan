import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { provideDocumentMetadata } from './useDocumentMetadata';
import { usePrint } from './usePrint';

function mountPrint() {
  let api: ReturnType<typeof usePrint> | undefined;
  const Client = defineComponent({
    setup() {
      api = usePrint();
      return () => h('div');
    },
  });
  const wrapper = mount(defineComponent({
    setup() {
      provideDocumentMetadata({ router: undefined, document, homeIntroduction: ref({ kind: 'inactive' }), continueHomeIntroduction: () => {}, finishHomeIntroduction: () => {} });
      return () => h(Client);
    },
  }));
  if (api === undefined) throw new Error('Print client did not mount');
  return {
    api,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('usePrint composable', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    vi.spyOn(window, 'print').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

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
    using fixture = mountPrint();
    const { activePrintMode, print, markPrintReady } = fixture.api;
    const testTitle = 'New Print Title';

    // Start print flow
    const printPromise = print({ title: testTitle, mode: 'chat' });

    // Verify mode is set and title swapped
    expect(activePrintMode.value).toBe('chat');
    expect(document.title).toBe(testTitle);

    // Printing must not begin before the print subtree reports readiness.
    expect(window.print).not.toHaveBeenCalled();

    // Simulate component being ready
    markPrintReady();

    await printPromise;

    // Verify window.print called and state restored
    expect(window.print).toHaveBeenCalled();
    expect(activePrintMode.value).toBeUndefined();
    expect(document.title).toBe('Naidan');
  });

  it('should restore state when window.print itself throws', async () => {
    using fixture = mountPrint();
    const { activePrintMode, print, markPrintReady } = fixture.api;
    vi.mocked(window.print).mockImplementationOnce(() => {
      throw new Error('Native print failed');
    });

    const printPromise = print({ title: 'Throwing Print', mode: 'chat' });
    expect(activePrintMode.value).toBe('chat');
    markPrintReady();

    await expect(printPromise).rejects.toThrow('Native print failed');
    expect(activePrintMode.value).toBeUndefined();
    expect(document.title).toBe('Naidan');
  });

  it('should support repeated print cycles without stale state', async () => {
    using fixture = mountPrint();
    const { activePrintMode, print, markPrintReady } = fixture.api;

    for (let index = 0; index < 2; index += 1) {
      const printPromise = print({ title: `Print ${index}`, mode: 'chat' });
      expect(activePrintMode.value).toBe('chat');
      expect(window.print).toHaveBeenCalledTimes(index);

      markPrintReady();
      await printPromise;

      expect(activePrintMode.value).toBeUndefined();
      expect(document.title).toBe('Naidan');
    }

    expect(window.print).toHaveBeenCalledTimes(2);
  });

  it('should restore state even if an error occurs during printing', async () => {
    using fixture = mountPrint();
    const { activePrintMode, print } = fixture.api;
    const setter = Object.getOwnPropertyDescriptor(Document.prototype, 'title')?.set;
    if (setter === undefined) throw new Error('Missing native title setter');
    vi.spyOn(document, 'title', 'set').mockImplementation(value => {
      if (value === 'Boom') throw new Error('Title Swap Failed');
      setter.call(document, value);
    });
    await expect(print({ title: 'Boom', mode: 'chat' })).rejects.toThrow('Title Swap Failed');
    expect(activePrintMode.value).toBeUndefined();
    vi.restoreAllMocks();
  });
});
