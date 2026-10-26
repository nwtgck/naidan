<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import type { CspHintActivityForDisplayOnly } from '@/components/csp/types';
import { readLoadedRpcRelayForDisplayOnly, subscribeRpcState } from '@/features/naidan-rpc-integration/runtime/feature';

/**
 * Place warnings and hints where people using Naidan are focused
 * at that point in their task.
 *
 * While editing a setting, show the warning beside the relevant field.
 * After an action fails, show the hint directly below its error message.
 *
 * Keep advance warnings compact. Expanded guidance may use more space.
 * activityForDisplayOnly selects copy, never an endpoint or an action.
 */
const props = defineProps<{ registrationId: NaidanRpcRegistrationId | undefined, presentation: 'compact' | 'error', activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined }>();
const relay = ref<string>();
let epoch = 0, disposed = false;

function refresh(): void {
  if (disposed) {
    return;
  }
  const token = ++epoch, id = props.registrationId;
  try {
    const pending = readLoadedRpcRelayForDisplayOnly({ registrationId: id });
    if (pending === undefined) {
      relay.value = undefined;
      return;
    }
    void pending.then(value => {
      if (!disposed && token === epoch && props.registrationId === id) {
        relay.value = value;
      }
    }).catch(() => {
      if (!disposed && token === epoch) {
        relay.value = undefined;
      }
    });
  } catch {
    relay.value = undefined;
  }
}

let unsubscribe: (() => void) | undefined;
try {
  unsubscribe = subscribeRpcState({ listener: refresh });
} catch {
  // Observation must remain optional even if the host's subscription fails.
}
watch(() => props.registrationId, () => {
  relay.value = undefined;
  refresh();
}, { immediate: true });
onScopeDispose(() => {
  disposed = true;
  epoch++;
  try {
    unsubscribe?.();
  } catch {
    // Disposal of a display observer must not escape into the existing UI.
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
  <CspMessageHint :target="relay === undefined ? undefined : { kind: 'relay', url: relay }" :presentation="presentation" :activity-for-display-only="activityForDisplayOnly" />
</template>
