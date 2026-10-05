<script setup lang="ts">
import { computed, ref, onScopeDispose } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { lazyStrings, ensureStrings } from '@/strings';
import ExperimentalFeatureRow from '@/components/ExperimentalFeatureRow.vue';
import { requestRpcStop, rpcStopStatus, subscribeRpcState } from '@/features/naidan-peer-rpc/runtime/feature';

const { settings, updateExperimental } = useSettings();
const pending = ref(false), failed = ref('');
const stopStatus = ref(rpcStopStatus());
onScopeDispose(subscribeRpcState({ listener: () => {
  stopStatus.value = rpcStopStatus();
} }));
const stopMessage = computed(() => {
  const value = stopStatus.value;
  switch (value) {
  case 'idle': return undefined;
  case 'checking': case 'requested': return lazyStrings.naidanRpc__checking_stop_status();
  case 'applied': return lazyStrings.naidanRpc__new_calls_blocked_waiting_for_completion();
  case 'retired': return lazyStrings.naidanRpc__rpc_connections_stopped();
  case 'unconfirmed': return lazyStrings.naidanRpc__stop_not_confirmed_check_managing_tab();
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
});
const status = computed(() => settings.value.experimental?.naidanRpc ?? 'disabled');
const isEnabled = computed(() => {
  const value = status.value;
  switch (value) {
  case 'enabled': return true;
  case 'disabled': return false;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
});
const copy = computed(() => {
  const title = lazyStrings.naidanRpc__title(), summary = lazyStrings.naidanRpc__summary(), details = lazyStrings.naidanRpc__feature_details();
  const toggleLabel = isEnabled.value ? lazyStrings.naidanRpc__disable() : lazyStrings.naidanRpc__enable();
  return title && summary && details && toggleLabel ? { title, summary, details, toggleLabel } : undefined;
});
async function toggle(): Promise<void> {
  if (pending.value) return;
  pending.value = true; failed.value = '';
  const next = isEnabled.value ? 'disabled' : 'enabled';
  try {
    // OFF closes current authority before persistence, never after a slow save.
    if (isEnabled.value) {
      // The stop acknowledgement and setting persistence are independent.
      // A frozen owner remains "unconfirmed", never a false successful stop.
      requestRpcStop();
    }
    await updateExperimental({ updater: ({ experimental }) => ({ ...experimental, naidanRpc: next }) });
  } catch {
    failed.value = await ensureStrings.naidanRpc__failed();
  } finally {
    pending.value = false;
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <ExperimentalFeatureRow v-if="copy" id="feature-naidan-rpc" :title="copy.title" :summary="copy.summary" :details="copy.details"
                          :status="status" :toggle-availability="pending ? 'unavailable' : 'available'" :toggle-label="copy.toggleLabel"
                          toggle-test-id="feature-naidan-rpc-toggle" @toggle="toggle" />
  <p v-if="stopMessage" role="status" data-testid="rpc-stop-status" tw-class="text-sm text-gray-600 dark:text-gray-400">{{ stopMessage }}</p>
  <button v-if="stopStatus === 'unconfirmed'" type="button" data-testid="rpc-retry-stop" tw-class="text-sm underline" @click="requestRpcStop()">{{ lazyStrings.naidanRpc__check_stop_again() }}</button>
  <p v-if="failed" role="alert" tw-class="text-sm text-red-600">{{ failed }}</p>
</template>
