import { computed, onMounted, onScopeDispose, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { hasFirefoxWebGpuPollingIssue } from '@/features/llama-cpp-browser/firefox-webgpu-warning';
import { resolveProfilePreference, type ProfileState } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { usesWebGpu, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import { scheduleIdleTask } from '@/utils/idle-task';

/** The caller owns the chat/Welcome Screen context. Options and capabilities
 * belong to the shared service, not to a particular chat or installed model. */
export function useFirefoxWebGpuWarning({ enabled }: { enabled: ComputedRef<boolean> }) {
  const affectedBrowser = ref(false);
  const active = computed(() => enabled.value && affectedBrowser.value);
  const options = shallowRef<RuntimeOptions>();
  const profileState = shallowRef<ProfileState>({ status: 'idle' });
  const needsInitialProbe = computed(() => {
    const state = profileState.value;
    switch (state.status) {
    case 'idle': return true;
    case 'checking': case 'ready': case 'error': return false;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled profile state: ${exhaustive}`);
    }
    }
  });

  onMounted(() => {
    affectedBrowser.value = typeof navigator !== 'undefined'
      && hasFirefoxWebGpuPollingIssue({ userAgent: navigator.userAgent });
  });
  onScopeDispose(() => {
    affectedBrowser.value = false;
  });

  watch(active, (enabled, _previous, onCleanup) => {
    if (!enabled) {
      options.value = undefined;
      profileState.value = { status: 'idle' };
      return;
    }
    const unsubscribeProfiles = llamaCppBrowserService.subscribeProfiles({
      listener: ({ state }) => {
        profileState.value = state;
      },
    });
    const unsubscribeOptions = llamaCppBrowserService.subscribeOptions({
      listener: ({ options: next }) => {
        options.value = next;
      },
    });
    onCleanup(() => {
      unsubscribeOptions();
      unsubscribeProfiles();
    });
  }, { flush: 'sync' });

  watch(() => active.value ? options.value?.profile : undefined, (preference, _previous, onCleanup) => {
    if (preference === undefined || (preference !== 'auto' && !usesWebGpu({ profile: preference }))) return;
    // Ready/checking reports are already owned by the service. Do not retry a
    // failure or revive a released Worker merely because its state changed.
    if (!needsInitialProbe.value) return;
    const controller = new AbortController();
    const scheduled = scheduleIdleTask({
      timeoutMs: 250,
      fallbackDelayMs: 0,
      task: async () => {
        if (controller.signal.aborted || !needsInitialProbe.value) return;
        try {
          // Use the same Worker/build policy as generation, including auto's CPU
          // fallback. This probes support but never loads a model or native runtime.
          // The service coalesces concurrent observers; only it publishes results.
          await llamaCppBrowserService.probeProfiles({ signal: controller.signal });
        } catch {
          // Unknown support is not evidence for a performance warning. Capability
          // failures remain available in runtime settings; no toast or retry loop.
        }
      },
    });
    onCleanup(() => {
      scheduled.cancel();
      // Detach only this observer. Never cancel/release the shared inference lane.
      controller.abort();
    });
  });

  const visible = computed(() => {
    if (!active.value || options.value === undefined) return false;
    const state = profileState.value;
    switch (state.status) {
    case 'idle': case 'checking': case 'error': return false;
    case 'ready': {
      const profile = resolveProfilePreference({ preference: options.value.profile, capabilities: state.capabilities });
      return profile !== undefined && usesWebGpu({ profile })
        && state.capabilities.profiles.some(entry => entry.profile === profile && entry.status === 'available');
    }
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled profile state: ${exhaustive}`);
    }
    }
  });

  return {
    visible,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
