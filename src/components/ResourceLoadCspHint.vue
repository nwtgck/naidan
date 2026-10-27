<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  resources: readonly Readonly<{
    element: HTMLImageElement | HTMLMediaElement | undefined,
    url: string | undefined,
    destination: 'image' | 'media',
  }>[],
}>();
type ResourceElement = HTMLImageElement | HTMLMediaElement;
type Binding = {
  element: ResourceElement,
  source: string,
  url: string,
  destination: 'image' | 'media',
  failed: boolean,
  dispose: () => void,
};
const bindings = new Map<ResourceElement, Binding>();
const revision = ref(0);
let disposed = false;

function current({ binding }: { binding: Binding }): boolean {
  return !disposed && bindings.get(binding.element) === binding && binding.element.isConnected
    && props.resources.some(resource => resource.element === binding.element && resource.url === binding.source && resource.destination === binding.destination);
}

function forget({ binding }: { binding: Binding }): void {
  try {
    binding.dispose();
  } catch { /* A diagnostic listener cleanup cannot interrupt the owning UI. */ }
  bindings.delete(binding.element);
}

function observe(): void {
  try {
    const wanted = new Map<ResourceElement, { source: string, url: string, destination: 'image' | 'media' }>();
    if (props.resources.length <= 16) {
      for (const resource of props.resources) {
        const { element, url, destination } = resource;
        if (element === undefined || url === undefined || url.length === 0 || url.length > 4_096) {
          continue;
        }
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
        if (!absolute && element.baseURI.length > 4_096) {
          continue;
        }
        const resolved = absolute ? new URL(url) : new URL(url, element.baseURI);
        wanted.set(element, { source: url, url: resolved.href, destination });
      }
    }
    for (const binding of bindings.values()) {
      const desired = wanted.get(binding.element);
      if (desired === undefined || desired.source !== binding.source || desired.url !== binding.url || desired.destination !== binding.destination) {
        forget({ binding });
      }
    }
    for (const [element, desired] of wanted) {
      if (bindings.has(element)) {
        continue;
      }
      const cleanup: (() => void)[] = [];
      const binding: Binding = {
        element,
        ...desired,
        failed: false,
        dispose() {
          for (const remove of cleanup) {
            try {
              remove();
            } catch { /* Try every passive listener cleanup. */ }
          }
        },
      };
      const onError = () => {
        try {
          // Empty/old currentSrc cannot identify which source failed. Keep the
          // existing element alone instead of guessing from its latest src attr.
          if (!disposed && bindings.get(element) === binding) {
            binding.failed = current({ binding }) && element.currentSrc !== '' && element.currentSrc === binding.url;
            revision.value++;
          }
        } catch {
          binding.failed = false;
          revision.value++;
        }
      };
      const onLoaded = () => {
        try {
          if (current({ binding })) {
            binding.failed = false;
            revision.value++;
          }
        } catch {
          binding.failed = false;
          revision.value++;
        }
      };
      bindings.set(element, binding);
      try {
        element.addEventListener('error', onError, { passive: true });
        cleanup.push(() => element.removeEventListener('error', onError));
        for (const name of ['load', 'loadedmetadata', 'loadeddata']) {
          element.addEventListener(name, onLoaded, { passive: true });
          cleanup.push(() => element.removeEventListener(name, onLoaded));
        }
      } catch {
        forget({ binding });
      }
    }
    revision.value++;
  } catch {
    for (const binding of bindings.values()) {
      forget({ binding });
    }
    revision.value++;
  }
}

watch(() => props.resources, observe, { immediate: true, flush: 'post' });
onScopeDispose(() => {
  disposed = true;
  for (const binding of bindings.values()) {
    forget({ binding });
  }
});
const target = computed(() => {
  void revision.value;
  try {
    if (props.resources.length > 16) {
      return undefined;
    }
    const resources = [...bindings.values()].filter(binding => binding.failed && current({ binding })).map(binding => ({ url: binding.url, destination: binding.destination, realm: 'document' as const }));
    return resources.length === 0 ? undefined : { kind: 'resource-list' as const, resources };
  } catch {
    return undefined;
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <CspMessageHint v-if="target !== undefined" v-bind="$attrs" :target="target" presentation="error" :activity-for-display-only="undefined" />
</template>
