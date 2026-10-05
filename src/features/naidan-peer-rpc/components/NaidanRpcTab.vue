<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { useConfirm } from '@/composables/useConfirm';
import { lazyStrings, ensureStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { NaidanRpcConnectionId } from '@/01-models/ids';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import type { NaidanPipingPeerVerifier, NaidanPipingRole } from '@/features/naidan-piping-duplex';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-peer-rpc/runtime/feature';
import type { NaidanPeerManager, RpcConnectionView, RpcConnectionPhase } from '@/features/naidan-peer-rpc/runtime/manager';
import type { NaidanPeerMethodName } from '@/features/naidan-peer-rpc/contract';

const views = shallowRef<RpcConnectionView[]>([]), manager = shallowRef<NaidanPeerManager>();
const selected = shallowRef<NaidanRpcConnectionId>(), busy = ref(false), failure = ref('');
const adding = ref(false), server = ref(''), headers = ref<{ name: string, value: string }[]>([]);
const code = ref(''), role = ref<NaidanPipingRole>('initiator'), label = ref('');
const methods = ref<NaidanPeerMethodName[]>([]);
const verification = shallowRef<{ text: string, decide({ approved }: { approved: boolean }): void }>();
const pending = new AbortController();
const { showConfirm } = useConfirm();
const provisionAvailable = __BUILD_MODE_IS_HOSTED__;
const chatMethods = ['listChatModels', 'generateChat'] as const satisfies readonly NaidanPeerMethodName[];
const imageMethods = ['listImageModels', 'generateImage'] as const satisfies readonly NaidanPeerMethodName[];
const current = computed(() => views.value.find(view => view.connection.id === selected.value));
let mounted = true;
const sync = () => {
  if (!mounted || !manager.value) return;
  views.value = manager.value.list();
  if (!selected.value || !views.value.some(view => view.connection.id === selected.value)) {
    const next = views.value[0]?.connection.id;
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
  if (selected.value) choose({ id: selected.value });
}
onMounted(() => {
  void action({ run: reload });
});
function choose({ id }: { id: NaidanRpcConnectionId }): void {
  selected.value = id; adding.value = false;
  const view = views.value.find(view => view.connection.id === id);
  if (!view) return;
  label.value = view.connection.label; server.value = view.connection.transport.serverUrl;
  headers.value = view.connection.transport.headers.map(({ name, value }) => ({ name, value }));
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
  const id = await manager.value.pair({ settings: settings(), code: code.value, role: role.value, verifyPeer, signal: pending.signal });
  code.value = ''; sync(); choose({ id });
}
function toggleMethod({ name, enabled }: { name: NaidanPeerMethodName, enabled: boolean }): void {
  methods.value = enabled ? [...new Set([...methods.value, name])] : methods.value.filter(value => value !== name);
}
async function applyMethods(): Promise<void> {
  if (current.value) await manager.value?.updateAllowedMethods({ id: current.value.connection.id, allowedMethods: methods.value });
}
async function remember(): Promise<void> {
  if (current.value) await manager.value?.remember({ id: current.value.connection.id, label: label.value });
}
async function connect(): Promise<void> {
  if (current.value) await manager.value?.connect({ id: current.value.connection.id });
}
async function disconnect(): Promise<void> {
  if (!current.value) return;
  const disconnectCurrent = manager.value?.prepareDisconnect({ id: current.value.connection.id });
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
  const id = current.value.connection.id;
  if (await showConfirm({ title: await ensureStrings.naidanRpc__forget_confirm() })) await manager.value?.forget({ id });
}
async function saveConnection(): Promise<void> {
  if (current.value) await manager.value?.edit({ id: current.value.connection.id, label: label.value, transport: settings() });
}
async function rename(): Promise<void> {
  if (current.value) await manager.value?.rename({ id: current.value.connection.id, label: label.value });
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
  <section tw-class="space-y-5" data-testid="naidan-rpc-tab">
    <header tw-class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 tw-class="text-xl font-bold">{{ lazyStrings.naidanRpc__title() }}</h2><p tw-class="mt-1 text-sm text-gray-500">{{ lazyStrings.naidanRpc__summary() }}</p></div>
      <button type="button" :disabled="busy" @click="newConnection" tw-class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="rpc-new">{{ lazyStrings.naidanRpc__new_connection() }}</button>
    </header>
    <p v-if="failure" role="alert" tw-class="rounded-xl border border-red-200 p-3 text-sm text-red-700">{{ failure }}</p>
    <div tw-class="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside tw-class="space-y-2">
        <h3 tw-class="text-sm font-bold text-gray-500">{{ lazyStrings.naidanRpc__connections() }}</h3>
        <button v-for="view in views" :key="idToRaw({ id: view.connection.id })" :disabled="busy" type="button" @click="choose({ id: view.connection.id })"
                :tw-class="['w-full rounded-xl border p-3 text-left', selected === view.connection.id && !adding ? 'border-blue-400 bg-blue-50 dark:bg-blue-950' : 'border-gray-200 dark:border-gray-700']">
          <span tw-class="block truncate text-sm font-bold">{{ view.connection.label }}</span><span tw-class="text-xs text-gray-500">{{ phaseLabel({ phase: view.phase }) }}</span>
        </button>
        <p v-if="!views.length" tw-class="text-xs text-gray-500">{{ lazyStrings.naidanRpc__no_connections() }}</p>
        <button type="button" :disabled="busy" @click="action({ run: reload })" tw-class="text-xs text-blue-600">{{ lazyStrings.naidanRpc__refresh() }}</button>
      </aside>
      <div tw-class="min-w-0 space-y-4">
        <div v-if="verification" tw-class="space-y-4 rounded-xl border-2 border-blue-400 p-4" data-testid="rpc-verification">
          <h3 tw-class="font-bold">{{ lazyStrings.naidanRpc__compare() }}</h3>
          <p tw-class="text-sm">{{ lazyStrings.naidanRpc__compare_help() }}</p>
          <code tw-class="block break-words rounded-lg bg-gray-100 p-3 text-lg leading-relaxed dark:bg-gray-900" data-testid="rpc-comparison">{{ verification.text }}</code>
          <div tw-class="flex flex-wrap gap-2">
            <button type="button" @click="verification.decide({ approved: true })" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" data-testid="rpc-approve">{{ lazyStrings.naidanRpc__matches() }}</button>
            <button type="button" @click="verification.decide({ approved: false })" tw-class="rounded-lg border px-4 py-2 text-sm">{{ lazyStrings.naidanRpc__reject() }}</button>
          </div>
        </div>
        <template v-if="adding">
          <div tw-class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <label tw-class="block text-sm font-bold">{{ lazyStrings.naidanRpc__code() }}<input v-model="code" :disabled="busy" inputmode="numeric" maxlength="8" tw-class="mt-2 block w-full rounded-lg border bg-transparent px-3 py-2 font-mono" data-testid="rpc-code" /></label>
            <p tw-class="text-xs text-gray-500">{{ lazyStrings.naidanRpc__code_help() }}</p>
            <select v-model="role" :disabled="busy" tw-class="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"><option value="initiator">{{ lazyStrings.naidanRpc__initiator() }}</option><option value="responder">{{ lazyStrings.naidanRpc__responder() }}</option></select>
          </div>
        </template>
        <template v-else-if="current">
          <div tw-class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="font-bold">{{ current.connection.label }}</h3><span tw-class="text-sm">{{ phaseLabel({ phase: current.phase }) }}</span></div>
            <p tw-class="text-xs text-gray-500">{{ current.persistence === 'saved' ? lazyStrings.naidanRpc__saved() : lazyStrings.naidanRpc__temporary() }}</p>
            <p v-if="current.failure" tw-class="text-sm text-amber-700">{{ current.failure }}</p>
            <button v-if="current.phase === 'disconnected'" type="button" :disabled="busy" @click="action({ run: connect })" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" data-testid="rpc-connect">{{ lazyStrings.naidanRpc__connect() }}</button>
            <button v-else type="button" @click="disconnectSafely" tw-class="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700" data-testid="rpc-disconnect">{{ lazyStrings.naidanRpc__disconnect() }}</button>
          </div>
          <div v-if="current.persistence === 'temporary'" tw-class="space-y-3 rounded-xl border border-blue-200 p-4" data-testid="rpc-remember-card">
            <p tw-class="text-sm">{{ lazyStrings.naidanRpc__remember_help() }}</p>
            <label tw-class="block text-xs font-bold">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" tw-class="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" /></label>
            <button type="button" :disabled="busy" @click="action({ run: remember })" tw-class="rounded-lg border border-blue-400 px-4 py-2 text-sm text-blue-600" data-testid="rpc-remember">{{ lazyStrings.naidanRpc__remember() }}</button>
          </div>
          <div v-if="current.persistence === 'saved'" tw-class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <label tw-class="block text-xs font-bold">{{ lazyStrings.naidanRpc__label() }}<input v-model="label" maxlength="100" :disabled="busy" data-testid="rpc-name" tw-class="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" /></label>
            <button type="button" :disabled="busy || current.phase === 'connecting' || current.phase === 'stopping'" @click="action({ run: rename })" data-testid="rpc-save-name" tw-class="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{{ lazyStrings.NaidanRpcTab__save_name() }}</button>
          </div>
          <div tw-class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700" data-testid="rpc-provided-methods">
            <h3 tw-class="font-bold">{{ lazyStrings.naidanRpc__provide() }}</h3><p tw-class="text-xs text-gray-500">{{ lazyStrings.naidanRpc__provide_help() }}</p>
            <p v-if="!provisionAvailable" tw-class="text-xs text-amber-700">{{ lazyStrings.naidanRpc__native_unavailable() }}</p>
            <fieldset v-for="group in [{ title: lazyStrings.naidanRpc__chat(), names: chatMethods }, { title: lazyStrings.naidanRpc__images(), names: imageMethods }]" :key="group.names[0]" :disabled="busy || !provisionAvailable" tw-class="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
              <legend tw-class="text-sm font-bold">{{ group.title }}</legend>
              <label v-for="name in group.names" :key="name" tw-class="flex items-center gap-2 text-xs"><input type="checkbox" :checked="methods.includes(name)" @change="toggleMethod({ name, enabled: ($event.target as HTMLInputElement).checked })" :data-testid="`rpc-method-${name}`" /><code>{{ name }}</code></label>
            </fieldset>
            <p v-if="!current.access.effective.length" tw-class="text-xs text-gray-500">{{ lazyStrings.naidanRpc__methods_empty() }}</p>
            <p v-if="current.access.persistence === 'failed'" role="alert" tw-class="text-sm text-amber-700">{{ lazyStrings.naidanRpc__methods_pending() }}</p>
            <button type="button" :disabled="busy || !provisionAvailable" @click="action({ run: applyMethods })" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="rpc-apply-methods">{{ lazyStrings.naidanRpc__apply_methods() }}</button>
          </div>
          <p tw-class="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-gray-900">{{ lazyStrings.naidanRpc__use_help() }}</p>
        </template>
        <div v-if="adding || current" tw-class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
          <h3 tw-class="text-sm font-bold">{{ lazyStrings.naidanRpc__transport() }} · Naidan Piping Duplex</h3>
          <p v-if="!adding && current?.phase !== 'disconnected'" tw-class="break-all text-xs text-gray-500">{{ server }}</p>
          <fieldset :disabled="busy || !adding && current?.phase !== 'disconnected'" tw-class="space-y-3">
            <label tw-class="block text-xs font-bold">{{ lazyStrings.naidanRpc__server() }}<input v-model="server" placeholder="https://relay.example" tw-class="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" data-testid="rpc-server" /></label>
            <h4 tw-class="text-xs font-bold">{{ lazyStrings.naidanRpc__headers() }}</h4>
            <div v-for="(header, index) in headers" :key="index" tw-class="flex flex-wrap gap-2">
              <input v-model="header.name" :aria-label="lazyStrings.naidanRpc__header_name()" tw-class="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm" />
              <input v-model="header.value" type="password" autocomplete="off" :aria-label="lazyStrings.naidanRpc__header_value()" tw-class="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm" />
              <button type="button" @click="headers.splice(index, 1)" tw-class="text-xs text-red-600">{{ lazyStrings.naidanRpc__remove_header() }}</button>
            </div>
            <button type="button" :disabled="headers.length >= 16" @click="headers.push({ name: '', value: '' })" tw-class="text-xs text-blue-600">{{ lazyStrings.naidanRpc__add_header() }}</button>
          </fieldset>
          <button v-if="adding" type="button" :disabled="busy || !server || !/^[0-9]{4,8}$/.test(code)" @click="action({ run: pair })" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="rpc-start">{{ lazyStrings.naidanRpc__start() }}</button>
          <button v-else type="button" :disabled="busy || current?.phase !== 'disconnected'" @click="action({ run: saveConnection })" tw-class="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{{ lazyStrings.naidanRpc__save_connection() }}</button>
          <button v-if="adding && busy" type="button" @click="manager?.cancelPairing()" tw-class="ml-3 text-sm text-red-600">{{ lazyStrings.naidanRpc__reject() }}</button>
        </div>
        <button v-if="current && !adding" type="button" :disabled="busy" @click="action({ run: forget })" tw-class="text-xs text-red-600">{{ lazyStrings.naidanRpc__forget() }}</button>
      </div>
    </div>
  </section>
</template>
