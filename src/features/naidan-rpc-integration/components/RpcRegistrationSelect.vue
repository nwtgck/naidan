<script setup lang="ts">
import { onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-rpc-integration/runtime/feature';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';

const props = defineProps<{ modelValue: NaidanRpcRegistrationId | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: NaidanRpcRegistrationId | undefined] }>();
const router = useRouter();
const registrations = shallowRef<RpcRegistrationView[]>([]), failed = ref(false);
let disposed = false;
const unsubscribe = subscribeRpcState({
  listener: () => {
    void refresh();
  },
});
onScopeDispose(() => {
  disposed = true; unsubscribe();
});

async function refresh(): Promise<void> {
  try {
    const manager = await getRpcManager();
    if (!disposed) {
      registrations.value = manager.list().filter(item => item.persistence === 'saved'); failed.value = false;
    }
  } catch {
    if (!disposed) failed.value = true;
  }
}

onMounted(async () => {
  try {
    await (await getRpcManager()).reload(); await refresh();
  } catch {
    if (!disposed) failed.value = true;
  }
});

function select({ value }: { value: string }): void {
  emit('update:modelValue', registrations.value.find(item => idToRaw({ id: item.registration.id }) === value)?.registration.id);
}

function manage(): void {
  void router.push({ query: { ...router.currentRoute.value.query, settings: 'naidan-rpc' } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2" data-testid="rpc-registration-select">
    <label tw-class="block text-xs font-bold text-gray-500">{{ lazyStrings.naidanRpc__choose_connection() }}</label>
    <select :value="props.modelValue ? idToRaw({ id: props.modelValue }) : ''" @change="select({ value: ($event.target as HTMLSelectElement).value })"
            tw-class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" data-testid="rpc-selected-registration">
      <option value="">{{ lazyStrings.naidanRpc__choose_connection() }}</option>
      <option v-for="entry in registrations" :key="idToRaw({ id: entry.registration.id })" :value="idToRaw({ id: entry.registration.id })">{{ entry.registration.label }}</option>
      <option v-if="modelValue && !registrations.some(entry => entry.registration.id === modelValue)" :value="idToRaw({ id: modelValue })" disabled>{{ idToRaw({ id: modelValue }) }}</option>
    </select>
    <p v-if="failed" tw-class="text-xs text-amber-700">{{ lazyStrings.naidanRpc__enable_first() }}</p>
    <p v-else-if="!registrations.length" tw-class="text-xs text-gray-500">{{ lazyStrings.naidanRpc__no_connections() }}</p>
    <button type="button" @click="manage" tw-class="text-xs font-semibold text-blue-600">{{ lazyStrings.naidanRpc__manage() }}</button>
  </div>
</template>
