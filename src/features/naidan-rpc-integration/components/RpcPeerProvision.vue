<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RefreshCwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { NaidanPeerManager, RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import type { NaidanPeerControlledMethodName, PeerProvidedMethods } from '@/features/naidan-rpc-integration/contract';

const props = defineProps<{ manager: Pick<NaidanPeerManager, 'getPeerProvidedMethods'> | undefined, registration: RpcRegistrationView | undefined }>();
const status = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const provided = shallowRef<PeerProvidedMethods>();
const connected = computed(() => props.registration?.phase === 'connected');
let epoch = 0, disposed = false;
let pending: AbortController | undefined;

function invalidate(): void {
  epoch++; pending?.abort(); pending = undefined;
  provided.value = undefined; status.value = 'idle';
}

async function refresh(): Promise<void> {
  const manager = props.manager, registration = props.registration;
  if (!manager || registration?.phase !== 'connected') return;
  pending?.abort(); const controller = new AbortController(); pending = controller;
  const token = ++epoch, id = registration.registration.id;
  provided.value = undefined; status.value = 'loading';
  const current = () => !disposed && token === epoch && !controller.signal.aborted && props.registration?.registration.id === id && connected.value;
  try {
    const result = await manager.getPeerProvidedMethods({ id, signal: controller.signal });
    if (current()) {
      provided.value = result; status.value = 'ready';
    }
  } catch {
    if (current()) status.value = 'failed';
  } finally {
    if (pending === controller) pending = undefined;
  }
}

// Health and local setting snapshots do not create a new peer. Requery only
// for the actual session, or an explicit refresh/focus, to avoid discovery
// calls themselves perpetually invalidating idle connection observations.
watch([() => props.manager, () => props.registration?.registration.id, () => props.registration?.phase, () => props.registration?.connectionToken], () => {
  invalidate();
  if (connected.value) void refresh();
}, { immediate: true, flush: 'sync' });

function focus(): void {
  if (connected.value && status.value !== 'loading') void refresh();
}

window.addEventListener('focus', focus);
onScopeDispose(() => {
  disposed = true; invalidate(); window.removeEventListener('focus', focus);
});

function groupState({ names }: { names: readonly NaidanPeerControlledMethodName[] }): string | undefined {
  const count = names.filter(name => provided.value?.methods.some(method => method.name === name)).length;
  if (count === 0) return lazyStrings.RpcPeerProvision__not_provided();
  if (count === names.length) return lazyStrings.RpcPeerProvision__provided();
  return lazyStrings.RpcPeerProvision__partially_provided();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-3 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30" data-testid="rpc-peer-provision">
    <header tw-class="flex items-center justify-between gap-3">
      <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.RpcPeerProvision__available_from_peer() }}</h3>
      <button type="button" :disabled="!connected" @click="refresh" :aria-label="lazyStrings.naidanRpc__refresh()" :title="lazyStrings.naidanRpc__refresh()" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-blue-400" data-testid="rpc-peer-provision-refresh"><RefreshCwIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
    </header>
    <p v-if="!connected" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="rpc-peer-provision-status">{{ lazyStrings.RpcPeerProvision__connect_to_check() }}</p>
    <p v-else-if="status === 'loading' || provided?.status === 'checking'" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="rpc-peer-provision-status">{{ lazyStrings.RpcPeerProvision__checking_provided_functions() }}</p>
    <p v-else-if="status === 'failed'" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300" data-testid="rpc-peer-provision-status">{{ lazyStrings.RpcPeerProvision__could_not_check() }}</p>
    <dl v-else-if="provided?.status === 'ready'" tw-class="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100 bg-gray-50/50 text-xs dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-800/20">
      <div tw-class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"><dt tw-class="font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.RpcPeerProvision__chat_inference() }}</dt><dd tw-class="text-gray-500 dark:text-gray-400" data-testid="rpc-peer-chat">{{ groupState({ names: ['listChatModels', 'generateChat'] }) }}</dd></div>
      <div tw-class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"><dt tw-class="font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.RpcPeerProvision__image_generation() }}</dt><dd tw-class="text-gray-500 dark:text-gray-400" data-testid="rpc-peer-images">{{ groupState({ names: ['listImageModels', 'generateImage'] }) }}</dd></div>
    </dl>
  </section>
</template>
