import { computed, onScopeDispose, ref, type Ref } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router';
import { requestAppSettings, useAppEntry } from '@/composables/useAppEntry';
import { isAppInteractionEnabled, useAppPresentation } from '@/composables/useAppPresentation';
import { createDeveloperToolEntries, developerToolAvailable, type DeveloperToolEntry } from '@/logic/developer-tools';

export function useDeveloperTools({ settingsOpener, onModelSupport, onNavigate }: {
  settingsOpener: Readonly<Ref<HTMLElement | undefined>> | undefined,
  onModelSupport: ({ opener }: { opener: HTMLElement | undefined }) => void,
  onNavigate: (({ focus }: { focus: 'restore' | 'handoff' }) => void) | undefined,
}) {
  const router = useRouter();
  const appEntry = useAppEntry();
  const { appInteraction } = useAppPresentation();
  const interactive = computed(() => appEntry.interaction.value === 'ready' && isAppInteractionEnabled({ interaction: appInteraction.value }));
  const entries = createDeveloperToolEntries();
  const opening = ref<string>();
  const navigationError = ref<string>();
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });

  async function open({ entry, opener }: { entry: DeveloperToolEntry, opener: EventTarget | undefined }): Promise<void> {
    if (disposed || !interactive.value || opening.value !== undefined || !developerToolAvailable({ entry })) {
      return;
    }
    navigationError.value = undefined;
    const action = entry.action;
    switch (action.kind) {
    case 'model-support': onModelSupport({ opener: opener instanceof HTMLElement ? opener : undefined });
      return;
    case 'settings': {
      const originalOpener = settingsOpener?.value;
      requestAppSettings({ tab: 'developer', opener: originalOpener?.isConnected ? originalOpener : opener instanceof HTMLElement ? opener : undefined });
      onNavigate?.({ focus: 'handoff' });
      return;
    }
    case 'route': break;
    default: {
      const exhaustive: never = action;
      throw new Error(String(exhaustive));
    }
    }
    opening.value = entry.id;
    try {
      // Reopening this page must retain any existing diagnostic URL settings.
      const failure = router.currentRoute.value.path.replace(/\/+$/, '') === action.path ? undefined : await router.push(action.path);
      if (disposed) {
        return;
      }
      if (failure) {
        const message = failure.message;
        if (!isNavigationFailure(failure, NavigationFailureType.duplicated)) {
          navigationError.value = message;
          return;
        }
      }
      onNavigate?.({ focus: 'restore' });
    } catch (error) {
      if (!disposed) {
        navigationError.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (!disposed) {
        opening.value = undefined;
      }
    }
  }

  return { entries, interactive, opening, navigationError, open, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
