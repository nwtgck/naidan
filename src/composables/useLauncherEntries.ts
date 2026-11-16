import { computed, ref } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router';
import { selectLauncherEntries, type LauncherCategory, type LauncherEntry } from '@/logic/launcher';
import { useChatReturn } from '@/composables/useChatReturn';
import { useLauncherSettings } from '@/composables/useLauncherSettings';

export function useLauncherEntries({ query, blocked }: { query: () => string, blocked: () => boolean }) {
  const router = useRouter();
  const { chatReturnPath } = useChatReturn();
  const category = ref<LauncherCategory>('all');
  const navigationError = ref<string>();
  const { unimplementedLauncherEntries } = useLauncherSettings();
  const allEntries = computed(() => selectLauncherEntries({ category: 'all', query: '', unimplementedLauncherEntries: unimplementedLauncherEntries.value }));
  const entries = computed(() => selectLauncherEntries({ category: category.value, query: query(), unimplementedLauncherEntries: unimplementedLauncherEntries.value }));

  function pathFor({ destination }: { destination: Exclude<LauncherEntry['destination'], { kind: 'unimplemented' }> }): string {
    switch (destination.kind) {
    case 'route': return destination.path;
    case 'chat': return chatReturnPath.value;
    default: {
      const exhaustive: never = destination;
      throw new Error(String(exhaustive));
    }
    }
  }

  async function follow({ event, path }: { event: MouseEvent, path: string }): Promise<boolean> {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return false;
    }
    if (blocked()) {
      event.preventDefault();
      return false;
    }
    event.preventDefault();
    navigationError.value = undefined;
    try {
      if (router.currentRoute.value.path.replace(/\/+$/, '') === path.replace(/\/+$/, '')) {
        return true;
      }
      const failure = await router.push(path);
      if (failure) {
        const message = failure.message;
        if (!isNavigationFailure(failure, NavigationFailureType.duplicated)) {
          navigationError.value = message;
          return false;
        }
      }
      return true;
    } catch (error) {
      navigationError.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  return {
    category,
    entries,
    allEntries,
    follow,
    pathFor,
    navigationError,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
