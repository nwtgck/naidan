<script setup lang="ts">
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { ArrowUpRightIcon, NetworkIcon, PlugZapIcon, PlusIcon, RefreshCwIcon, SaveIcon, Settings2Icon, ShieldCheckIcon, UnplugIcon } from 'lucide-vue-next';
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
import RpcSettingsButton from './RpcSettingsButton.vue';

const views = shallowRef<RpcRegistrationView[]>([]), manager = shallowRef<NaidanPeerManager>();
const selected = shallowRef<NaidanRpcRegistrationId>(), busy = ref(false), failure = ref('');
const failureRelay = ref<string>();
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
  if (!mounted || !manager.value) {
    return;
  }
  views.value = manager.value.list();
  if (!selected.value || !views.value.some(view => view.registration.id === selected.value)) {
    const next = views.value[0]?.registration.id;
    selected.value = next;
    // A removed row may select another peer. Rebind the entire draft, never
    // carry the old peer's methods or credentials into that peer's form.
    // A new-pairing form is independent and must survive registry changes.
    if (!adding.value) {
      if (next) {
        choose({ id: next });
      } else {
        label.value = '';
        server.value = '';
        headers.value = [];
        methods.value = [];
      }
    }
  }
};

const unsubscribe = subscribeRpcState({ listener: sync });
onScopeDispose(() => {
  mounted = false;
  unsubscribe();
  pending.abort();
  verification.value?.decide({ approved: false });
});

async function action({ run, relay }: { run(): Promise<void>, relay: string | undefined }): Promise<void> {
  if (busy.value) {
    return;
  }
  busy.value = true;
  failure.value = '';
  failureRelay.value = undefined;
  try {
    await run();
  } catch {
    if (mounted) {
      failure.value = await ensureStrings.naidanRpc__failed();
      failureRelay.value = relay;
    }
  } finally {
    busy.value = false;
    sync();
  }
}

async function reload(): Promise<void> {
  manager.value = await getRpcManager();
  await manager.value.reload();
  sync();
  // Refreshing the registry must preserve an in-progress pairing form.
  if (adding.value) {
    return;
  }
  if (selected.value) {
    choose({ id: selected.value });
  } else {
    newConnection();
  }
}

onMounted(() => {
  void action({ run: reload, relay: undefined });
});

function choose({ id }: { id: NaidanRpcRegistrationId }): void {
  selected.value = id;
  adding.value = false;
  const view = views.value.find(view => view.registration.id === id);
  if (!view) {
    return;
  }
  label.value = view.registration.label;
  server.value = view.registration.transport.serverUrl;
  headers.value = view.registration.transport.headers.map(({ name, value }) => ({ name, value }));
  methods.value = [...view.access.effective];
}

function newConnection(): void {
  adding.value = true;
  code.value = '';
  server.value = '';
  headers.value = [];
  label.value = '';
}

function settings(): NaidanRpcTransportSettings {
  return { type: 'naidan_piping_duplex', serverUrl: server.value, headers: headers.value.map(({ name, value }) => ({ name, value })) };
}

const verifyPeer: NaidanPipingPeerVerifier = ({ comparison, signal }) => new Promise(resolve => {
  let done = false;
  const finish = ({ approved }: { approved: boolean }) => {
    if (done) {
      return;
    }
    done = true;
    signal.removeEventListener('abort', abort);
    verification.value = undefined;
    resolve(approved);
  };
  const abort = () => finish({ approved: false });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted || !mounted) {
    abort();
    return;
  }
  // This is the full 256-bit binding, not a shortened fingerprint or the rendezvous number.
  const text = Array.from(comparison, byte => byte.toString(16).padStart(2, '0')).join('').match(/.{1,8}/g)?.join(' ') ?? '';
  verification.value = { text, decide: finish };
});

async function pair(): Promise<void> {
  if (!manager.value) {
    return;
  }
  const id = await manager.value.pair({ settings: settings(), code: code.value, verifyPeer, signal: pending.signal });
  code.value = '';
  sync();
  choose({ id });
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
  if (current.value) {
    await manager.value?.updateInboundAllowedMethods({ id: current.value.registration.id, inboundAllowedMethods: methods.value });
  }
}

async function remember(): Promise<void> {
  if (current.value) {
    await manager.value?.remember({ id: current.value.registration.id, label: label.value });
  }
}

async function connect(): Promise<void> {
  if (current.value) {
    await manager.value?.connect({ id: current.value.registration.id });
  }
}

async function disconnect(): Promise<void> {
  if (!current.value) {
    return;
  }
  const disconnectCurrent = manager.value?.prepareDisconnect({ id: current.value.registration.id });
  if (await showConfirm({ title: await ensureStrings.naidanRpc__disconnect_confirm() })) {
    await disconnectCurrent?.();
  }
}

async function disconnectSafely(): Promise<void> {
  // A connect/save command may be pending. Stopping must remain available and
  // must not be blocked by the ordinary form's busy guard.
  try {
    await disconnect();
  } catch {
    if (mounted) {
      failure.value = await ensureStrings.naidanRpc__failed();
      failureRelay.value = undefined;
    }
  } finally {
    sync();
  }
}

async function forget(): Promise<void> {
  if (!current.value) {
    return;
  }
  const id = current.value.registration.id;
  if (await showConfirm({ title: await ensureStrings.naidanRpc__forget_confirm() })) {
    await manager.value?.forget({ id });
  }
}

async function saveRegistration(): Promise<void> {
  if (current.value) {
    await manager.value?.edit({ id: current.value.registration.id, label: label.value, transport: settings() });
  }
}

async function rename(): Promise<void> {
  if (current.value) {
    await manager.value?.rename({ id: current.value.registration.id, label: label.value });
  }
}

async function toggleConnectOnStartup({ event }: { event: Event }): Promise<void> {
  const input = event.target as HTMLInputElement;
  const connectOnStartup = input.checked ? 'enabled' : 'disabled';
  // Display saved intent only. A failed save must not leave the native control
  // showing an enabled policy that the manager never accepted.
  input.checked = current.value?.registration.connectOnStartup === 'enabled';
  await action({
    relay: undefined,
    run: async () => {
      if (current.value) {
        await manager.value?.setConnectOnStartup({ id: current.value.registration.id, connectOnStartup });
      }
    },
  });
}

function phaseLabel({ phase, health }: { phase: RpcConnectionPhase; health: RpcRegistrationView['health'] }): string | undefined {
  switch (phase) {
  case 'disconnected': return lazyStrings.naidanRpc__disconnected();
  case 'connecting': return lazyStrings.naidanRpc__connecting();
  case 'connected': {
    const state = health?.state;
    switch (state) {
    case 'checking': return lazyStrings.naidanRpc__checking_response();
    case 'healthy': case undefined: return lazyStrings.naidanRpc__connected();
    default: {
      const exhaustive: never = state;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'stopping': return lazyStrings.naidanRpc__stopping();
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="@container space-y-6 text-gray-800 dark:text-gray-100" data-testid="naidan-rpc-tab">
    <header tw-class="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200/70 pb-5 dark:border-gray-800">
      <div tw-class="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <span tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-100/70 bg-blue-50/70 text-blue-500 dark:border-blue-500/15 dark:bg-blue-500/10 dark:text-blue-400"><NetworkIcon aria-hidden="true" tw-class="h-5 w-5" /></span>
        <div tw-class="min-w-0">
          <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.naidanRpc__title() }}</h2>
          <p tw-class="mt-1 max-w-xl text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__summary() }}</p>
        </div>
      </div>
      <RpcSettingsButton :disabled="busy" appearance="primary" @click="newConnection" data-testid="rpc-new"><PlusIcon aria-hidden="true" :stroke-width="2.5" tw-class="h-4.5 w-4.5 shrink-0" />{{ lazyStrings.naidanRpc__new_connection() }}</RpcSettingsButton>
    </header>
    <p v-if="failure" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ failure }}</p>
    <CspMessageHint activity-for-display-only="relay" v-if="failure && failureRelay !== undefined && (!current?.failure || failureRelay !== current.registration.transport.serverUrl)" :target="{ kind: 'relay', url: failureRelay }" presentation="error" />
    <div tw-class="grid items-start gap-6 @3xl:grid-cols-[12rem_minmax(0,1fr)]">
      <aside tw-class="min-w-0 space-y-1 border-b border-gray-200/70 pb-5 dark:border-gray-800 @3xl:border-b-0 @3xl:border-r @3xl:pb-0 @3xl:pr-5">
        <div tw-class="flex items-center justify-between gap-2 px-1 pb-2">
          <h3 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__connections() }}</h3>
          <button type="button" :disabled="busy" @click="action({ run: reload, relay: undefined })" :aria-label="lazyStrings.naidanRpc__refresh()" :title="lazyStrings.naidanRpc__refresh()" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-blue-400" data-testid="rpc-refresh"><RefreshCwIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
        </div>
        <button v-for="view in views" :key="idToRaw({ id: view.registration.id })" :disabled="busy" type="button" @click="choose({ id: view.registration.id })"
                :aria-pressed="selected === view.registration.id && !adding"
                :tw-class="['w-full rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50', selected === view.registration.id && !adding ? 'bg-gray-100/70 text-gray-900 dark:bg-gray-800/70 dark:text-gray-100' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40']">
          <span tw-class="block truncate text-xs font-medium">{{ view.registration.label }}</span>
          <span tw-class="mt-1 inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"><span aria-hidden="true" :tw-class="['h-1.5 w-1.5 rounded-full', view.phase === 'connected' && view.health?.state !== 'checking' ? 'bg-emerald-500' : view.phase === 'connecting' || view.phase === 'stopping' || view.health?.state === 'checking' ? 'bg-amber-500' : 'bg-gray-400']"></span>{{ phaseLabel({ phase: view.phase, health: view.health }) }}</span>
        </button>
        <p v-if="!views.length" tw-class="px-1 pb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__no_connections() }}</p>
      </aside>
      <div tw-class="min-w-0 space-y-6">
        <div v-if="verification" tw-class="space-y-4 rounded-2xl border border-blue-200/70 bg-blue-50/40 p-4 dark:border-blue-500/25 dark:bg-blue-500/5 sm:p-5" data-testid="rpc-verification">
          <h3 tw-class="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100"><ShieldCheckIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500" />{{ lazyStrings.naidanRpc__compare() }}</h3>
          <p tw-class="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.naidanRpc__compare_help() }}</p>
          <code tw-class="block break-words rounded-xl border border-blue-200/60 bg-white/80 p-3 font-mono text-sm leading-7 tracking-wide text-gray-800 dark:border-blue-500/20 dark:bg-gray-900/70 dark:text-gray-100 sm:p-4" data-testid="rpc-comparison">{{ verification.text }}</code>
          <div tw-class="flex flex-wrap gap-2">
            <RpcSettingsButton :disabled="false" appearance="primary" @click="verification.decide({ approved: true })" data-testid="rpc-approve">{{ lazyStrings.naidanRpc__matches() }}</RpcSettingsButton>
            <RpcSettingsButton :disabled="false" appearance="secondary" @click="verification.decide({ approved: false })">{{ lazyStrings.naidanRpc__reject() }}</RpcSettingsButton>
          </div>
        </div>
        <template v-if="adding">
          <div tw-class="space-y-2">
            <label tw-class="block text-xs font-medium text-gray-600 dark:text-gray-400">{{ lazyStrings.naidanRpc__code() }}<input v-model="code" :disabled="busy" :maxlength="RPC_PAIRING_CODE_MAX_LENGTH" autocomplete="off" tw-class="mt-2 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" data-testid="rpc-code" /></label>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__code_help() }}</p>
          </div>
        </template>
        <template v-else-if="current">
          <div tw-class="space-y-3">
            <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="min-w-0 break-words text-sm font-semibold text-gray-800 dark:text-gray-100">{{ current.registration.label }}</h3><span data-testid="rpc-connection-state" :tw-class="['rounded-lg px-2.5 py-1 text-xs font-medium', current.phase === 'connected' && current.health?.state !== 'checking' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : current.health?.state === 'checking' ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300']">{{ phaseLabel({ phase: current.phase, health: current.health }) }}</span></div>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ current.persistence === 'saved' ? lazyStrings.naidanRpc__saved() : lazyStrings.naidanRpc__temporary() }}</p>
            <CspMessageHint activity-for-display-only="relay" v-if="!current.failure" :target="{ kind: 'relay', url: current.registration.transport.serverUrl }" presentation="compact" />
            <p v-if="current.phase === 'disconnected' && current.desiredConnection === 'connected' && current.recoveryStatus === 'ready'" role="status" data-testid="rpc-maintaining" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__connecting() }}</p>
            <p v-if="current.recoveryStatus === 'waiting-capacity'" role="status" data-testid="rpc-capacity-wait" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__waiting_for_capacity() }}</p>
            <p v-if="current.failure" tw-class="text-sm text-amber-700 dark:text-amber-300">{{ current.failure }}</p>
            <CspMessageHint activity-for-display-only="relay" v-if="current.failure" :target="{ kind: 'relay', url: current.registration.transport.serverUrl }" presentation="error" />
            <div tw-class="flex flex-wrap gap-2 pt-1">
              <RpcSettingsButton v-if="current.phase === 'disconnected' || current.recoveryStatus === 'waiting-peer'" :disabled="busy" appearance="primary" @click="action({ run: connect, relay: current.registration.transport.serverUrl })" data-testid="rpc-connect"><PlugZapIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.naidanRpc__connect() }}</RpcSettingsButton>
              <RpcSettingsButton v-if="current.phase !== 'disconnected' || current.desiredConnection === 'connected'" :disabled="false" appearance="danger" @click="disconnectSafely" data-testid="rpc-disconnect"><UnplugIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.naidanRpc__disconnect() }}</RpcSettingsButton>
            </div>
          </div>
          <div v-if="current.persistence === 'temporary'" tw-class="space-y-4 rounded-2xl border border-blue-200/60 bg-blue-50/30 p-4 text-gray-700 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-gray-200 sm:p-5" data-testid="rpc-remember-card">
            <p tw-class="text-sm leading-relaxed">{{ lazyStrings.naidanRpc__remember_help() }}</p>
            <label tw-class="block text-xs font-medium">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" tw-class="mt-2 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" /></label>
            <RpcSettingsButton appearance="primary" :disabled="busy" @click="action({ run: remember, relay: undefined })" data-testid="rpc-remember"><SaveIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.naidanRpc__remember() }}</RpcSettingsButton>
          </div>
          <div v-if="current.persistence === 'saved'" tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800">
            <label tw-class="block text-xs font-medium text-gray-600 dark:text-gray-400">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" data-testid="rpc-name" tw-class="mt-2 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" /></label>
            <RpcSettingsButton appearance="secondary" :disabled="busy || current.phase === 'connecting' || current.phase === 'stopping'" @click="action({ run: rename, relay: undefined })" data-testid="rpc-save-name">{{ lazyStrings.NaidanRpcTab__save_name() }}</RpcSettingsButton>
          </div>
          <div tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800">
            <label tw-class="flex items-center justify-between gap-3">
              <span tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.NaidanRpcTab__connect_automatically_on_startup() }}</span>
              <ToggleSwitch>
                <input type="checkbox" role="switch" :checked="current.registration.connectOnStartup === 'enabled'" :aria-checked="current.registration.connectOnStartup === 'enabled'" :disabled="busy || current.persistence !== 'saved' || current.registryPersistence !== 'durable'" @change="toggleConnectOnStartup({ event: $event })" data-testid="rpc-connect-on-startup" />
              </ToggleSwitch>
            </label>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ current.persistence === 'saved' && current.registryPersistence === 'durable' ? lazyStrings.NaidanRpcTab__automatic_connection_help() : lazyStrings.NaidanRpcTab__save_with_persistent_storage_first() }}</p>
          </div>
          <div tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800" data-testid="rpc-provided-methods">
            <h3 tw-class="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100"><ArrowUpRightIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.naidanRpc__provide() }}</h3><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__provide_help() }}</p>
            <p v-if="!provisionAvailable" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.naidanRpc__native_unavailable() }}</p>
            <fieldset v-for="group in methodGroups" :key="group.key" :disabled="busy || !provisionAvailable" tw-class="min-w-0 rounded-xl border border-gray-200/60 bg-gray-50/40 dark:border-gray-800 dark:bg-gray-800/20">
              <ImageSettingsSection v-model:open="methodDetails[group.key]" embedded compact :title="group.title" :summary="undefined" :data-testid="`rpc-details-${group.key}`">
                <template #summary>
                  <span tw-class="inline-flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px]">
                    <span v-if="methodGroupState({ names: group.names }) === 'partial'" :data-testid="`rpc-partial-${group.key}`">{{ lazyStrings.NaidanRpcTab__partially_enabled() }}</span>
                    <span>{{ lazyStrings.NaidanRpcTab__method_details() }}</span>
                    <label :aria-label="group.title" @click.stop tw-class="inline-flex shrink-0 cursor-pointer items-center">
                      <ToggleSwitch><input type="checkbox" role="switch" :aria-label="group.title" :checked="methodGroupState({ names: group.names }) !== 'off'" :aria-checked="methodGroupState({ names: group.names }) !== 'off'" @change="toggleMethodGroup({ names: group.names, enabled: ($event.target as HTMLInputElement).checked })" :data-testid="`rpc-provide-${group.key}`" /></ToggleSwitch>
                    </label>
                  </span>
                </template>
                <label v-for="name in group.names" :key="name" tw-class="flex min-w-0 items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input type="checkbox" :checked="methods.includes(name)" @change="toggleMethod({ name, enabled: ($event.target as HTMLInputElement).checked })" :data-testid="`rpc-method-${name}`" /></SettingsChoiceControl><code tw-class="min-w-0 break-all">{{ name }}</code></label>
              </ImageSettingsSection>
            </fieldset>
            <p v-if="!current.access.effective.length" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__methods_empty() }}</p>
            <p v-if="current.access.persistence === 'failed'" role="alert" tw-class="text-sm text-amber-700 dark:text-amber-300">{{ lazyStrings.naidanRpc__methods_pending() }}</p>
            <RpcSettingsButton appearance="primary" :disabled="busy || !provisionAvailable" @click="action({ run: applyMethods, relay: undefined })" data-testid="rpc-apply-methods">{{ lazyStrings.naidanRpc__apply_methods() }}</RpcSettingsButton>
          </div>
          <RpcPeerProvision :manager="manager" :registration="current" />
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__use_help() }}</p>
        </template>
        <div v-if="adding || current" tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800">
          <h3 tw-class="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100"><Settings2Icon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.naidanRpc__transport() }}</h3>
          <p v-if="!adding && current?.phase !== 'disconnected'" tw-class="break-all text-xs text-gray-500 dark:text-gray-400">{{ server }}</p>
          <fieldset :disabled="busy || !adding && current?.phase !== 'disconnected'" tw-class="min-w-0 space-y-3">
            <label tw-class="block text-xs font-medium text-gray-600 dark:text-gray-400">{{ lazyStrings.naidanRpc__server() }}<input v-model="server" placeholder="https://piping.example" tw-class="mt-2 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" data-testid="rpc-server" /></label>
            <h4 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.naidanRpc__headers() }}</h4>
            <div v-for="(header, index) in headers" :key="index" tw-class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input v-model="header.name" :aria-label="lazyStrings.naidanRpc__header_name()" tw-class="col-start-1 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" />
              <input v-model="header.value" type="password" autocomplete="off" :aria-label="lazyStrings.naidanRpc__header_value()" tw-class="col-start-1 @lg:col-start-2 w-full min-w-0 min-h-10 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 text-xs text-gray-800 outline-none transition-colors hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-blue-500/60 dark:focus:bg-gray-900" />
              <button type="button" @click="headers.splice(index, 1)" tw-class="col-start-2 row-start-1 row-span-2 min-h-10 @lg:col-start-3 @lg:row-span-1 rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__remove_header() }}</button>
            </div>
            <button type="button" :disabled="headers.length >= 16" @click="headers.push({ name: '', value: '' })" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-blue-400"><PlusIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0" />{{ lazyStrings.naidanRpc__add_header() }}</button>
          </fieldset>
          <CspMessageHint activity-for-display-only="relay" v-if="adding || server !== current?.registration.transport.serverUrl" :target="{ kind: 'relay', url: server }" presentation="compact" />
          <RpcSettingsButton v-if="adding" :disabled="busy || !server || !isValidRpcPairingCode({ code })" appearance="primary" @click="action({ run: pair, relay: server })" data-testid="rpc-start"><PlugZapIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.naidanRpc__start() }}</RpcSettingsButton>
          <RpcSettingsButton v-else :disabled="busy || current?.phase !== 'disconnected'" appearance="secondary" @click="action({ run: saveRegistration, relay: undefined })"><SaveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.naidanRpc__save_connection() }}</RpcSettingsButton>
          <button v-if="adding && busy" type="button" @click="manager?.cancelPairing()" tw-class="ml-3 rounded-lg px-2 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__reject() }}</button>
        </div>
        <button v-if="current && !adding" type="button" :disabled="busy" @click="action({ run: forget, relay: undefined })" tw-class="rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-900/20">{{ lazyStrings.naidanRpc__forget() }}</button>
      </div>
    </div>
  </section>
</template>
