<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { NetworkIcon, PlusIcon, RefreshCwIcon, SaveIcon, ShieldCheckIcon } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { lazyStrings, ensureStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import type { NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-rpc-integration/runtime/feature';
import type { NaidanPeerManager, RpcRegistrationView, RpcConnectionPhase } from '@/features/naidan-rpc-integration/runtime/manager';
import type { NaidanPeerControlledMethodName } from '@/features/naidan-rpc-integration/contract';
import { isValidRpcPairingCode, RPC_PAIRING_CODE_MAX_LENGTH } from '@/features/naidan-rpc-integration/runtime/pairing-code';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';
import RpcPeerProvision from './RpcPeerProvision.vue';

const views = shallowRef<RpcRegistrationView[]>([]), manager = shallowRef<NaidanPeerManager>();
const selected = shallowRef<NaidanRpcRegistrationId>(), busy = ref(false), failure = ref('');
const adding = ref(false), server = ref(''), headers = ref<{ name: string, value: string }[]>([]);
const code = ref(''), label = ref('');
const methods = ref<NaidanPeerControlledMethodName[]>([]);
const verification = shallowRef<{ text: string, decide({ approved }: { approved: boolean }): void }>();
const pending = new AbortController();
const { showConfirm } = useConfirm();
const provisionAvailable = __BUILD_MODE_IS_HOSTED__;
const chatMethods = ['listChatModels', 'generateChat'] as const satisfies readonly NaidanPeerControlledMethodName[];
const imageMethods = ['listImageModels', 'generateImage'] as const satisfies readonly NaidanPeerControlledMethodName[];
const methodDetails = ref({ chat: false, images: false });
const methodGroups = computed(() => [
  { key: 'chat' as const, title: lazyStrings.naidanRpc__chat(), names: chatMethods },
  { key: 'images' as const, title: lazyStrings.naidanRpc__images(), names: imageMethods },
]);
const current = computed(() => views.value.find(view => view.registration.id === selected.value));
let mounted = true;
const sync = () => {
  if (!mounted || !manager.value) return;
  views.value = manager.value.list();
  if (!selected.value || !views.value.some(view => view.registration.id === selected.value)) {
    const next = views.value[0]?.registration.id;
    selected.value = next;
    // A removed row may select another peer. Rebind the entire draft, never
    // carry the old peer's methods or credentials into that peer's form.
    // A new-pairing form is independent and must survive registry changes.
    if (!adding.value) {
      if (next) choose({ id: next });
      else {
        label.value = ''; server.value = ''; headers.value = []; methods.value = [];
      }
    }
  }
};
const unsubscribe = subscribeRpcState({ listener: sync });
onScopeDispose(() => {
  mounted = false; unsubscribe(); pending.abort(); verification.value?.decide({ approved: false });
});
async function action({ run }: { run(): Promise<void> }): Promise<void> {
  if (busy.value) return;
  busy.value = true; failure.value = '';
  try {
    await run();
  } catch {
    if (mounted) failure.value = await ensureStrings.naidanRpc__failed();
  } finally {
    busy.value = false; sync();
  }
}
async function reload(): Promise<void> {
  manager.value = await getRpcManager(); await manager.value.reload(); sync();
  // Refreshing the registry must preserve an in-progress pairing form.
  if (adding.value) return;
  if (selected.value) choose({ id: selected.value });
  else newConnection();
}
onMounted(() => {
  void action({ run: reload });
});
function choose({ id }: { id: NaidanRpcRegistrationId }): void {
  selected.value = id; adding.value = false;
  const view = views.value.find(view => view.registration.id === id);
  if (!view) return;
  label.value = view.registration.label; server.value = view.registration.transport.serverUrl;
  headers.value = view.registration.transport.headers.map(({ name, value }) => ({ name, value }));
  methods.value = [...view.access.effective];
}
function newConnection(): void {
  adding.value = true; code.value = ''; server.value = ''; headers.value = []; label.value = '';
}
function settings(): NaidanRpcTransportSettings {
  return { type: 'naidan_piping_duplex', serverUrl: server.value, headers: headers.value.map(({ name, value }) => ({ name, value })) };
}
const verifyPeer: NaidanPipingPeerVerifier = ({ comparison, signal }) => new Promise(resolve => {
  let done = false;
  const finish = ({ approved }: { approved: boolean }) => {
    if (done) return; done = true;
    signal.removeEventListener('abort', abort); verification.value = undefined; resolve(approved);
  };
  const abort = () => finish({ approved: false });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted || !mounted) {
    abort(); return;
  }
  // This is the full 256-bit binding, not a shortened fingerprint or the rendezvous number.
  const text = Array.from(comparison, byte => byte.toString(16).padStart(2, '0')).join('').match(/.{1,8}/g)?.join(' ') ?? '';
  verification.value = { text, decide: finish };
});
async function pair(): Promise<void> {
  if (!manager.value) return;
  const id = await manager.value.pair({ settings: settings(), code: code.value, verifyPeer, signal: pending.signal });
  code.value = ''; sync(); choose({ id });
}
function toggleMethod({ name, enabled }: { name: NaidanPeerControlledMethodName, enabled: boolean }): void {
  methods.value = enabled ? [...new Set([...methods.value, name])] : methods.value.filter(value => value !== name);
}
function methodGroupState({ names }: { names: readonly NaidanPeerControlledMethodName[] }): 'off' | 'partial' | 'on' {
  const count = names.filter(name => methods.value.includes(name)).length;
  return count === 0 ? 'off' : count === names.length ? 'on' : 'partial';
}
function toggleMethodGroup({ names, enabled }: { names: readonly NaidanPeerControlledMethodName[], enabled: boolean }): void {
  methods.value = enabled ? [...new Set([...methods.value, ...names])] : methods.value.filter(name => !names.includes(name));
}
async function applyMethods(): Promise<void> {
  if (current.value) await manager.value?.updateInboundAllowedMethods({ id: current.value.registration.id, inboundAllowedMethods: methods.value });
}
async function remember(): Promise<void> {
  if (current.value) await manager.value?.remember({ id: current.value.registration.id, label: label.value });
}
async function connect(): Promise<void> {
  if (current.value) await manager.value?.connect({ id: current.value.registration.id });
}
async function disconnect(): Promise<void> {
  if (!current.value) return;
  const disconnectCurrent = manager.value?.prepareDisconnect({ id: current.value.registration.id });
  if (await showConfirm({ title: await ensureStrings.naidanRpc__disconnect_confirm() })) await disconnectCurrent?.();
}
async function disconnectSafely(): Promise<void> {
  // A connect/save command may be pending. Stopping must remain available and
  // must not be blocked by the ordinary form's busy guard.
  try {
    await disconnect();
  } catch {
    if (mounted) failure.value = await ensureStrings.naidanRpc__failed();
  } finally {
    sync();
  }
}
async function forget(): Promise<void> {
  if (!current.value) return;
  const id = current.value.registration.id;
  if (await showConfirm({ title: await ensureStrings.naidanRpc__forget_confirm() })) await manager.value?.forget({ id });
}
async function saveRegistration(): Promise<void> {
  if (current.value) await manager.value?.edit({ id: current.value.registration.id, label: label.value, transport: settings() });
}
async function rename(): Promise<void> {
  if (current.value) await manager.value?.rename({ id: current.value.registration.id, label: label.value });
}
async function toggleConnectOnStartup({ event }: { event: Event }): Promise<void> {
  const input = event.target as HTMLInputElement;
  const connectOnStartup = input.checked ? 'enabled' : 'disabled';
  // Display saved intent only. A failed save must not leave the native control
  // showing an enabled policy that the manager never accepted.
  input.checked = current.value?.registration.connectOnStartup === 'enabled';
  await action({
    run: async () => {
      if (current.value) await manager.value?.setConnectOnStartup({ id: current.value.registration.id, connectOnStartup });
    },
  });
}
function phaseLabel({ phase }: { phase: RpcConnectionPhase }): string | undefined {
  switch (phase) {
  case 'disconnected': return lazyStrings.naidanRpc__disconnected();
  case 'connecting': return lazyStrings.naidanRpc__connecting();
  case 'connected': return lazyStrings.naidanRpc__connected();
  case 'stopping': return lazyStrings.naidanRpc__stopping();
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-6 text-gray-800 dark:text-gray-100" data-testid="naidan-rpc-tab">
    <header tw-class="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 pb-5 dark:border-gray-800">
      <div tw-class="min-w-0 flex-1">
        <h2 tw-class="flex items-center gap-2 text-lg font-bold tracking-tight text-gray-800 dark:text-white"><NetworkIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500" />{{ lazyStrings.naidanRpc__title() }}</h2>
        <p tw-class="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__summary() }}</p>
      </div>
      <button type="button" :disabled="busy" @click="newConnection" tw-class="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50" data-testid="rpc-new"><PlusIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.naidanRpc__new_connection() }}</button>
    </header>
    <p v-if="failure" role="alert" tw-class="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{{ failure }}</p>
    <div tw-class="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <aside tw-class="min-w-0 space-y-2 rounded-2xl border border-gray-100 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-800/20">
        <div tw-class="flex items-center justify-between gap-2 px-1 pb-2">
          <h3 tw-class="text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__connections() }}</h3>
          <button type="button" :disabled="busy" @click="action({ run: reload })" :aria-label="lazyStrings.naidanRpc__refresh()" :title="lazyStrings.naidanRpc__refresh()" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700 dark:hover:text-blue-400" data-testid="rpc-refresh"><RefreshCwIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        </div>
        <button v-for="view in views" :key="idToRaw({ id: view.registration.id })" :disabled="busy" type="button" @click="choose({ id: view.registration.id })"
                :aria-pressed="selected === view.registration.id && !adding"
                :tw-class="['w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50', selected === view.registration.id && !adding ? 'border-blue-100 bg-white text-blue-600 shadow-sm dark:border-blue-900/50 dark:bg-gray-800 dark:text-blue-400' : 'border-transparent text-gray-600 hover:bg-white/70 dark:text-gray-400 dark:hover:bg-gray-800/50']">
          <span tw-class="block truncate text-sm font-bold">{{ view.registration.label }}</span>
          <span tw-class="mt-1 inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><span aria-hidden="true" :tw-class="['h-1.5 w-1.5 rounded-full', view.phase === 'connected' ? 'bg-emerald-500' : view.phase === 'connecting' || view.phase === 'stopping' ? 'bg-amber-500' : 'bg-gray-400']"></span>{{ phaseLabel({ phase: view.phase }) }}</span>
        </button>
        <p v-if="!views.length" tw-class="px-1 pb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__no_connections() }}</p>
      </aside>
      <div tw-class="min-w-0 space-y-4">
        <div v-if="verification" tw-class="space-y-4 rounded-2xl border border-blue-200 bg-blue-50/50 p-5 shadow-sm dark:border-blue-800 dark:bg-blue-900/10" data-testid="rpc-verification">
          <h3 tw-class="flex items-center gap-2 text-sm font-bold text-blue-900 dark:text-blue-100"><ShieldCheckIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500" />{{ lazyStrings.naidanRpc__compare() }}</h3>
          <p tw-class="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.naidanRpc__compare_help() }}</p>
          <code tw-class="block break-words rounded-xl border border-blue-100 bg-white p-4 text-lg leading-relaxed text-blue-900 dark:border-blue-900/50 dark:bg-gray-900 dark:text-blue-100" data-testid="rpc-comparison">{{ verification.text }}</code>
          <div tw-class="flex flex-wrap gap-2">
            <button type="button" @click="verification.decide({ approved: true })" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20" data-testid="rpc-approve">{{ lazyStrings.naidanRpc__matches() }}</button>
            <button type="button" @click="verification.decide({ approved: false })" tw-class="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-600 shadow-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{{ lazyStrings.naidanRpc__reject() }}</button>
          </div>
        </div>
        <template v-if="adding">
          <div tw-class="space-y-4 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
            <label tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__code() }}<input v-model="code" :disabled="busy" :maxlength="RPC_PAIRING_CODE_MAX_LENGTH" autocomplete="off" tw-class="mt-2 block w-full rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-white" data-testid="rpc-code" /></label>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__code_help() }}</p>
          </div>
        </template>
        <template v-else-if="current">
          <div tw-class="space-y-3 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
            <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="min-w-0 break-words text-sm font-bold text-gray-800 dark:text-white">{{ current.registration.label }}</h3><span :tw-class="['rounded-lg px-2.5 py-1 text-xs font-medium', current.phase === 'connected' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300']">{{ phaseLabel({ phase: current.phase }) }}</span></div>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ current.persistence === 'saved' ? lazyStrings.naidanRpc__saved() : lazyStrings.naidanRpc__temporary() }}</p>
            <p v-if="current.phase === 'disconnected' && current.desiredConnection === 'connected' && current.recoveryStatus === 'ready'" role="status" data-testid="rpc-maintaining" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__connecting() }}</p>
            <p v-if="current.failure" tw-class="text-sm text-amber-700 dark:text-amber-300">{{ current.failure }}</p>
            <button v-if="current.phase === 'disconnected'" type="button" :disabled="busy" @click="action({ run: connect })" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50" data-testid="rpc-connect">{{ lazyStrings.naidanRpc__connect() }}</button>
            <button v-if="current.phase !== 'disconnected' || current.desiredConnection === 'connected'" type="button" @click="disconnectSafely" tw-class="rounded-xl border border-red-100 bg-white px-4 py-2.5 text-sm font-bold text-red-600 shadow-sm transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/20 dark:border-red-900/40 dark:bg-gray-800 dark:text-red-400 dark:hover:bg-red-900/20" data-testid="rpc-disconnect">{{ lazyStrings.naidanRpc__disconnect() }}</button>
          </div>
          <div v-if="current.persistence === 'temporary'" tw-class="space-y-4 rounded-2xl border border-blue-200 bg-blue-50 p-5 text-blue-900 shadow-sm dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-100" data-testid="rpc-remember-card">
            <p tw-class="text-sm leading-relaxed">{{ lazyStrings.naidanRpc__remember_help() }}</p>
            <label tw-class="block text-xs font-bold">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" tw-class="mt-2 w-full rounded-xl border border-blue-100 bg-white px-4 py-3 text-sm font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-blue-800 dark:bg-gray-800 dark:text-white" /></label>
            <button type="button" :disabled="busy" @click="action({ run: remember })" tw-class="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed" data-testid="rpc-remember"><SaveIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.naidanRpc__remember() }}</button>
          </div>
          <div v-if="current.persistence === 'saved'" tw-class="space-y-3 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
            <label tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" data-testid="rpc-name" tw-class="mt-2 w-full rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-white" /></label>
            <button type="button" :disabled="busy || current.phase === 'connecting' || current.phase === 'stopping'" @click="action({ run: rename })" data-testid="rpc-save-name" tw-class="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-600 shadow-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{{ lazyStrings.NaidanRpcTab__save_name() }}</button>
          </div>
          <div tw-class="space-y-3 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
            <label tw-class="flex items-center justify-between gap-3">
              <span tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.NaidanRpcTab__connect_automatically_on_startup() }}</span>
              <span tw-class="relative inline-flex shrink-0 cursor-pointer items-center">
                <input type="checkbox" role="switch" :checked="current.registration.connectOnStartup === 'enabled'" :aria-checked="current.registration.connectOnStartup === 'enabled'" :disabled="busy || current.persistence !== 'saved' || current.registryPersistence !== 'durable'" @change="toggleConnectOnStartup({ event: $event })" tw-class="sr-only peer" data-testid="rpc-connect-on-startup" />
                <span aria-hidden="true" tw-class="w-10 h-6 bg-gray-200 rounded-full dark:bg-gray-700 peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white dark:border-gray-600"></span>
              </span>
            </label>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ current.persistence === 'saved' && current.registryPersistence === 'durable' ? lazyStrings.NaidanRpcTab__automatic_connection_help() : lazyStrings.NaidanRpcTab__save_with_persistent_storage_first() }}</p>
          </div>
          <div tw-class="space-y-3 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30" data-testid="rpc-provided-methods">
            <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.naidanRpc__provide() }}</h3><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__provide_help() }}</p>
            <p v-if="!provisionAvailable" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.naidanRpc__native_unavailable() }}</p>
            <fieldset v-for="group in methodGroups" :key="group.key" :disabled="busy || !provisionAvailable" tw-class="rounded-xl border border-gray-100 bg-gray-50/50 dark:border-gray-800 dark:bg-gray-800/20">
              <ImageSettingsSection v-model:open="methodDetails[group.key]" embedded compact :title="group.title" :summary="undefined" :data-testid="`rpc-details-${group.key}`">
                <template #summary>
                  <span tw-class="inline-flex items-center justify-end gap-3 whitespace-nowrap">
                    <span v-if="methodGroupState({ names: group.names }) === 'partial'" :data-testid="`rpc-partial-${group.key}`">{{ lazyStrings.NaidanRpcTab__partially_enabled() }}</span>
                    <span>{{ lazyStrings.NaidanRpcTab__method_details() }}</span>
                    <label :aria-label="group.title" @click.stop tw-class="relative inline-flex shrink-0 cursor-pointer items-center">
                      <input type="checkbox" role="switch" :aria-label="group.title" :checked="methodGroupState({ names: group.names }) !== 'off'" :aria-checked="methodGroupState({ names: group.names }) !== 'off'" @change="toggleMethodGroup({ names: group.names, enabled: ($event.target as HTMLInputElement).checked })" :data-testid="`rpc-provide-${group.key}`" tw-class="sr-only peer" />
                      <span aria-hidden="true" tw-class="w-10 h-6 bg-gray-200 rounded-full dark:bg-gray-700 peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white dark:border-gray-600"></span>
                    </label>
                  </span>
                </template>
                <label v-for="name in group.names" :key="name" tw-class="flex min-w-0 items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><input type="checkbox" :checked="methods.includes(name)" @change="toggleMethod({ name, enabled: ($event.target as HTMLInputElement).checked })" :data-testid="`rpc-method-${name}`" tw-class="h-4 w-4 shrink-0 accent-blue-600 disabled:opacity-40" /><code tw-class="min-w-0 break-all">{{ name }}</code></label>
              </ImageSettingsSection>
            </fieldset>
            <p v-if="!current.access.effective.length" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__methods_empty() }}</p>
            <p v-if="current.access.persistence === 'failed'" role="alert" tw-class="text-sm text-amber-700 dark:text-amber-300">{{ lazyStrings.naidanRpc__methods_pending() }}</p>
            <button type="button" :disabled="busy || !provisionAvailable" @click="action({ run: applyMethods })" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50" data-testid="rpc-apply-methods">{{ lazyStrings.naidanRpc__apply_methods() }}</button>
          </div>
          <RpcPeerProvision :manager="manager" :registration="current" />
          <p tw-class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4 text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:bg-gray-800/20 dark:text-gray-400">{{ lazyStrings.naidanRpc__use_help() }}</p>
        </template>
        <div v-if="adding || current" tw-class="space-y-4 rounded-2xl border border-gray-200/80 bg-white/60 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
          <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.naidanRpc__transport() }}</h3>
          <p v-if="!adding && current?.phase !== 'disconnected'" tw-class="break-all text-xs text-gray-500 dark:text-gray-400">{{ server }}</p>
          <fieldset :disabled="busy || !adding && current?.phase !== 'disconnected'" tw-class="space-y-3">
            <label tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__server() }}<input v-model="server" placeholder="https://piping.example" tw-class="mt-2 w-full rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-white" data-testid="rpc-server" /></label>
            <h4 tw-class="text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__headers() }}</h4>
            <div v-for="(header, index) in headers" :key="index" tw-class="flex flex-wrap gap-2">
              <input v-model="header.name" :aria-label="lazyStrings.naidanRpc__header_name()" tw-class="min-w-0 flex-1 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
              <input v-model="header.value" type="password" autocomplete="off" :aria-label="lazyStrings.naidanRpc__header_value()" tw-class="min-w-0 flex-1 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-800 shadow-sm outline-none transition-all focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
              <button type="button" @click="headers.splice(index, 1)" tw-class="rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__remove_header() }}</button>
            </div>
            <button type="button" :disabled="headers.length >= 16" @click="headers.push({ name: '', value: '' })" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-blue-600 transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-900/20"><PlusIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0" />{{ lazyStrings.naidanRpc__add_header() }}</button>
          </fieldset>
          <button v-if="adding" type="button" :disabled="busy || !server || !isValidRpcPairingCode({ code })" @click="action({ run: pair })" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50" data-testid="rpc-start">{{ lazyStrings.naidanRpc__start() }}</button>
          <button v-else type="button" :disabled="busy || current?.phase !== 'disconnected'" @click="action({ run: saveRegistration })" tw-class="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-600 shadow-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{{ lazyStrings.naidanRpc__save_connection() }}</button>
          <button v-if="adding && busy" type="button" @click="manager?.cancelPairing()" tw-class="ml-3 rounded-lg px-2 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__reject() }}</button>
        </div>
        <button v-if="current && !adding" type="button" :disabled="busy" @click="action({ run: forget })" tw-class="rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__forget() }}</button>
      </div>
    </div>
  </section>
</template>
