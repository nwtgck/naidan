import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue';

type DocumentPictureInPicture = {
  requestWindow({ width, height }: { width: number, height: number }): Promise<Window>,
};

export function useAudioTranscriptionFloatingWindow({ microphone, title }: { microphone: Readonly<Ref<boolean>>, title: () => string }) {
  const api = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
  const supported = typeof api?.requestWindow === 'function';
  const target = shallowRef<Window>();
  const opening = shallowRef(false);
  let disposed = false;
  let stopStyleSync: (() => void) | undefined;

  function clearWindow(): void {
    target.value = undefined;
    stopStyleSync?.();
    stopStyleSync = undefined;
  }
  function close(): void {
    const previous = target.value;
    clearWindow();
    previous?.close();
  }
  watch(microphone, active => {
    if (!active) {
      close();
    }
  });
  onScopeDispose(() => {
    disposed = true;
    close();
  });

  async function show(): Promise<void> {
    if (!microphone.value || disposed || !supported || api === undefined || opening.value) {
      return;
    }
    if (target.value !== undefined) {
      target.value.focus();
      return;
    }
    opening.value = true;
    let opened: Window | undefined;
    try {
      opened = await api.requestWindow({ width: 400, height: 280 });
      if (disposed || !microphone.value) {
        opened.close();
        return;
      }
      const pipDocument = opened.document;
      pipDocument.title = title();
      const style = pipDocument.createElement('style');
      // The floating document needs its own copy of Naidan's generated CSS.
      // Use the already loaded rules so opening the window starts no fetches.
      const registeredStyles = document.head.querySelector('style[data-naidan-tailwind-runtime]');
      const syncStyles = () => {
        const root = pipDocument.documentElement;
        root.lang = document.documentElement.lang;
        root.dir = document.documentElement.dir;
        root.classList.toggle('dark', document.documentElement.classList.contains('dark'));
        root.style.colorScheme = document.documentElement.style.colorScheme;
        const css = registeredStyles?.textContent ?? '';
        if (style.textContent !== css) {
          style.textContent = css;
        }
      };
      syncStyles();
      pipDocument.head.append(style);
      const observer = new MutationObserver(syncStyles);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'lang', 'dir'] });
      if (registeredStyles !== null) {
        observer.observe(registeredStyles, { childList: true, characterData: true, subtree: true });
      }
      stopStyleSync = () => observer.disconnect();
      opened.addEventListener('pagehide', () => {
        if (target.value === opened) {
          clearWindow();
        }
      }, { once: true });
      target.value = opened;
    } catch (error) {
      opened?.close();
      throw error;
    } finally {
      opening.value = false;
    }
  }

  return {
    supported,
    opening: computed(() => opening.value),
    document: computed(() => target.value?.document),
    clipboardWindow: () => target.value?.document.hasFocus() ? target.value : window,
    show,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
