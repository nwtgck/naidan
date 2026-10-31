import { nextTick, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue';

/** Own only the message viewport, never scrollIntoView (which also scrolls the
 * page/ancestors). Content growth follows the bottom only while the user does. */
export function useLiveHistoryScroll({ viewport, content, revision, enabled }: {
  viewport: Ref<HTMLElement | undefined>, content: Ref<HTMLElement | undefined>, revision: () => unknown, enabled: () => boolean,
}) {
  const following = ref(true);
  let disposed = false;
  let observer: ResizeObserver | undefined;

  function rememberScroll(): void {
    const element = viewport.value;
    if (!enabled()) {
      return;
    }
    if (element) {
      following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }
  }

  function follow(): void {
    if (!disposed && enabled() && following.value && viewport.value) {
      viewport.value.scrollTop = viewport.value.scrollHeight;
    }
  }

  function toLatest(): void {
    following.value = true;
    follow();
  }

  // First-use setup is a form, not a chat log: never scroll the catalog away.
  watch(enabled, async active => {
    following.value = true;
    await nextTick();
    if (disposed || active !== enabled()) {
      return;
    }
    if (active) {
      follow();
    } else if (viewport.value) {
      viewport.value.scrollTop = 0;
    }
  }, { flush: 'post' });
  watch(revision, async () => {
    await nextTick();
    follow();
  }, { flush: 'post' });
  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(follow);
      if (content.value) {
        observer.observe(content.value);
      }
      if (viewport.value) {
        observer.observe(viewport.value);
      }
    }
    follow();
  });
  onScopeDispose(() => {
    disposed = true;
    observer?.disconnect();
  });
  return { following, rememberScroll, follow, toLatest, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
