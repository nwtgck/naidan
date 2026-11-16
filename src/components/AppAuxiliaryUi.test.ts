import { shallowRef } from 'vue';
import type { AppEntrySettingsOverlay, AppEntryDiscoveryTab } from '@/composables/useAppEntry';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, useRouter } from 'vue-router';
import AppAuxiliaryUi from './AppAuxiliaryUi.vue';
import type { DownloadTimingSnapshot } from '@/features/transformers-js/download-timing';

vi.mock('@/components/csp/DevelopmentMetaCspRecovery.vue', () => ({
  default: { name: 'DevelopmentMetaCspRecovery', template: '<!-- resident recovery host -->' },
}));

const timingMocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
const modelSupportCapability = vi.hoisted(() => ({ available: true }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ resolvedSettings: ref(null) }) }));
const entryIntent = shallowRef({ kind: 'ordinary' });
const settingsOverlay = shallowRef<AppEntrySettingsOverlay>();
const discovery = shallowRef<{ owner: symbol, tab: AppEntryDiscoveryTab }>();
const closeEntrySettings = vi.fn(() => {
  settingsOverlay.value = undefined;
});
const discoveryMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/composables/useAppEntry', () => ({
  loadModelDiscoveryPanel: () => import('@/components/ModelDiscoveryPanel.vue'),
  useAppEntry: () => ({
    intent: entryIntent,
    interaction: ref('ready'),
    settingsOverlay,
    discovery,
    modelSelection: ref(undefined),
    closeSettings: closeEntrySettings,
    closeDiscovery: () => {
      discovery.value = undefined;
    },
  }),
}));
vi.mock('@/components/ModelDiscoveryPanel.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'ModelDiscoveryPanel',
    props: ['visibility', 'tab', 'interaction'],
    emits: ['close'],
    setup() {
      discoveryMounts.count++;
    },
    template: '<div data-testid="model-discovery" :data-visibility="visibility" :data-tab="tab"><button @click="$emit(\'close\')">close</button></div>',
  },
}));
vi.mock('@/features/transformers-js', () => ({ transformersJsService: { getDownloadTimingSnapshot: timingMocks.snapshot } }));

function timingSnapshot(): DownloadTimingSnapshot {
  return {
    format: 'transformers-js-download-timing-v1',
    measurementVersion: 1,
    source: 'ordinary-download',
    serviceEpoch: '11111111-1111-4111-8111-111111111111',
    identityStatus: 'available',
    sequence: 1,
    availability: 'recorded',
    droppedOperations: 0,
    records: [{
      operationId: '11111111-1111-4111-8111-111111111111/1',
      modelId: 'org/previous',
      runtimeEpoch: 1,
      outcome: 'failed',
      timingStatus: 'measured',
      wallMs: 100,
      truncated: false,
      droppedObservations: 0,
      observations: [],
    }],
  };
}

vi.mock('vue-router', async importOriginal => ({
  ...await importOriginal<typeof import('vue-router')>(),
  useRoute: vi.fn(),
  useRouter: vi.fn(),
}));

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isWeshTerminalOpen: ref(false),
    toggleWeshTerminal: vi.fn(),
  }),
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    isFileExplorerOpen: ref(false),
  }),
}));

vi.mock('@/composables/usePrint', () => ({
  usePrint: () => ({
    activePrintMode: ref(undefined),
  }),
}));

const isSearchOpen = ref(false);
const isRecentOpen = ref(false);

vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen,
  }),
}));

vi.mock('@/composables/useRecentChats', () => ({
  useRecentChats: () => ({
    isRecentOpen,
  }),
}));

vi.mock('@/features/transformers-js/model-support-investigation', () => ({
  get isModelSupportInvestigationAvailable() {
    return modelSupportCapability.available;
  },
  loadModelSupportInvestigationModal: async () => ({
    name: 'ModelSupportInvestigationModal',
    props: ['modelId', 'ordinaryDownloadTiming'],
    emits: ['close'],
    template: '<div data-testid="model-support-investigation-modal-stub" :data-model-id="modelId"><button data-testid="model-support-investigation-close-stub" @click="$emit(\'close\')">close</button></div>',
  }),
}));

vi.mock('@/components/SettingsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'SettingsModal',
    props: ['isOpen', 'navigation', 'requestedTab', 'suspended'],
    emits: ['close', 'openModelSupportInvestigation'],
    template: '<div v-if="isOpen" data-testid="settings-modal" :data-suspended="suspended"><button data-testid="settings-open-model-support-investigation-stub" @click="$emit(\'openModelSupportInvestigation\', \'\')">open</button></div>',
  },
}));
vi.mock('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/features/global-search/components/GlobalSearchModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/RecentChatsModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/features/file-explorer/components/FileExplorerModal.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/PWAManager.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));
vi.mock('@/components/PrintView.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div><slot /></div>' },
}));
vi.mock('@/components/ChatPrintContent.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: { template: '<div />' },
}));

describe('AppAuxiliaryUi', () => {
  const route = reactive({
    path: '/',
    fullPath: '/',
    query: {} as Record<string, string>,
  });
  const push = vi.fn();
  const replace = vi.fn();

  beforeEach(() => {
    route.path = '/';
    route.fullPath = '/';
    route.query = {};
    push.mockClear();
    replace.mockClear();
    entryIntent.value = { kind: 'ordinary' };
    settingsOverlay.value = undefined;
    discovery.value = undefined;
    closeEntrySettings.mockClear();
    discoveryMounts.count = 0;
    timingMocks.snapshot.mockReset().mockReturnValue(undefined);
    modelSupportCapability.available = true;
    isSearchOpen.value = false;
    isRecentOpen.value = false;
    vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
    vi.mocked(useRouter).mockReturnValue({ push, replace, currentRoute: shallowRef(route) } as unknown as ReturnType<typeof useRouter>);
  });

  it('keeps recovery and the independent export host mounted across settings navigation', async () => {
    using mounted = {
      wrapper: mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const recovery = mounted.wrapper.getComponent({ name: 'DevelopmentMetaCspRecovery' }).vm;
    expect(mounted.wrapper.findComponent({ name: 'ImportExportModalHost' }).exists()).toBe(true);
    route.query = { settings: 'developer' };
    await flushPromises();
    expect(mounted.wrapper.getComponent({ name: 'DevelopmentMetaCspRecovery' }).vm).toBe(recovery);
    route.query = {};
    await flushPromises();
    expect(mounted.wrapper.getComponent({ name: 'DevelopmentMetaCspRecovery' }).vm).toBe(recovery);
    expect(mounted.wrapper.findComponent({ name: 'ImportExportModalHost' }).exists()).toBe(true);
  });

  it('does not retain a diagnostics modal host inside Settings', async () => {
    route.query = { settings: 'llama-cpp-browser' };
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="settings-modal-host"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="settings-modal"]').attributes('data-suspended')).toBe('false');
    expect(wrapper.findComponent({ name: 'LlamaCppBrowserDiagnosticsPage' }).exists()).toBe(false);
  });

  it.each(['/', '/chat/chat-1', '/settings/connection'])('keeps model previews at %s free of URL-driven settings and navigation', async path => {
    route.path = path;
    route.query = { 'llama-cpp-browser-model': 'hf.co/owner/repo:Q4_K_M', settings: 'llama-cpp-browser', q: 'hello' };
    const original = { ...route.query };
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(route.query).toEqual(original);
    wrapper.unmount();
  });

  it('opens and closes explicitly requested settings above a model preview without changing its URL', async () => {
    route.path = '/settings/developer';
    route.query = { 'llama-cpp-browser-model': 'owner/repo:Q4_K_M', settings: 'developer', q: 'hello' };
    entryIntent.value = { kind: 'model-preview' };
    const original = { ...route.query };
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    settingsOverlay.value = { owner: Symbol('entry'), tab: 'connection', opener: undefined };
    await flushPromises();
    const modal = wrapper.getComponent({ name: 'SettingsModal' });
    expect(modal.props('navigation')).toBe('local');
    expect(modal.props('requestedTab')).toBe('connection');
    wrapper.vm.TEST_ONLY.closeSettings();
    await flushPromises();
    expect(closeEntrySettings).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    expect(route.query).toEqual(original);
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not mount closed auxiliary overlays', async () => {
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-discovery"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('mounts model discovery only on first open and retains its instance between visits', async () => {
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();
    expect(discoveryMounts.count).toBe(0);
    const owner = Symbol('entry');
    discovery.value = { owner, tab: 'candidates' };
    await flushPromises();
    expect(discoveryMounts.count).toBe(1);
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('data-visibility')).toBe('open');
    await wrapper.get('[data-testid="model-discovery"] button').trigger('click');
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('data-visibility')).toBe('closed');
    discovery.value = { owner, tab: 'hugging-face' };
    await flushPromises();
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('data-tab')).toBe('hugging-face');
    expect(discoveryMounts.count).toBe(1);
    wrapper.unmount();
  });

  it('opens settings after post-startup UI is activated', async () => {
    route.query = { settings: '1' };
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('hands model support investigation off to the app-level host without destroying settings state', async () => {
    route.query = { settings: 'developer' };
    route.fullPath = '/?settings=developer';
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined }, attachTo: document.body });
    await flushPromises();

    const settingsHost = wrapper.get('[data-testid="settings-modal-host"]');
    expect(settingsHost.element.getAttribute('style') ?? '').not.toContain('display: none');

    const opener = wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').element as HTMLElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="settings-modal-host"]').element.getAttribute('style')).toContain('display: none');
    expect(wrapper.get('[data-testid="settings-modal"]').attributes('data-suspended')).toBe('true');
    expect(wrapper.find('[data-testid="model-support-investigation-modal-stub"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="model-support-investigation-modal-stub"]').attributes('data-model-id')).toBe('');
    expect(route.query).toEqual({ settings: 'developer' });

    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    await wrapper.get('[data-testid="model-support-investigation-close-stub"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="settings-modal-host"]').element.getAttribute('style') ?? '').not.toContain('display: none');
    expect(wrapper.find('[data-testid="model-support-investigation-modal-stub"]').exists()).toBe(false);
    expect(route.query).toEqual({ settings: 'developer' });
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
    document.body.removeAttribute('tabindex');
  });

  it('preserves the complete initial non-settings location for path-based settings close', () => {
    route.path = '/chat/chat-1';
    route.fullPath = '/chat/chat-1?leaf=message-1';
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });

    (wrapper.vm as unknown as { TEST_ONLY: { closeSettings(): void } }).TEST_ONLY.closeSettings();

    expect(push).toHaveBeenCalledWith('/chat/chat-1?leaf=message-1');
  });

  it('passes a detached ordinary-service snapshot at modal admission', async () => {
    route.query = { settings: 'developer' };
    const source = timingSnapshot();
    timingMocks.snapshot.mockReturnValue(source);
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();
    await wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').trigger('click');
    await flushPromises();
    source.records[0]!.outcome = 'completed';
    timingMocks.snapshot.mockReturnValue({ ...timingSnapshot(), serviceEpoch: '22222222-2222-4222-8222-222222222222' });
    const modal = wrapper.findComponent({ name: 'ModelSupportInvestigationModal' });
    expect(modal.props('ordinaryDownloadTiming')).toEqual(timingSnapshot());
    expect(timingMocks.snapshot).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it.each(['initial', 'mounted'] as const)('consumes an %s sidebar request through the existing modal admission and restores its opener', async admission => {
    using opener = {
      element: document.createElement('button'),
      [Symbol.dispose]() {
        this.element.remove();
      },
    };
    document.body.append(opener.element);
    const source = timingSnapshot();
    timingMocks.snapshot.mockReturnValue(source);
    const request = { opener: opener.element };
    using mounted = {
      wrapper: mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: admission === 'initial' ? request : undefined }, attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    if (admission === 'mounted') {
      await mounted.wrapper.setProps({ modelSupportInvestigationRequest: request });
      await flushPromises();
    }
    expect(mounted.wrapper.emitted('consumeModelSupportInvestigationRequest')).toEqual([[]]);
    const modal = mounted.wrapper.getComponent({ name: 'ModelSupportInvestigationModal' });
    expect(modal.props('modelId')).toBe('');
    source.records[0]!.outcome = 'completed';
    expect(modal.props('ordinaryDownloadTiming')).toEqual(timingSnapshot());
    expect(timingMocks.snapshot).toHaveBeenCalledOnce();
    await mounted.wrapper.setProps({ modelSupportInvestigationRequest: undefined });
    expect(mounted.wrapper.find('[data-testid="model-support-investigation-modal-stub"]').exists()).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    await mounted.wrapper.get('[data-testid="model-support-investigation-close-stub"]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(opener.element);
    await mounted.wrapper.setProps({ modelSupportInvestigationRequest: { opener: opener.element } });
    await flushPromises();
    expect(timingMocks.snapshot).toHaveBeenCalledTimes(2);
    expect(mounted.wrapper.emitted('consumeModelSupportInvestigationRequest')).toEqual([[], []]);
  });

  it('consumes an unavailable sidebar request without creating a modal or reading timing data', async () => {
    modelSupportCapability.available = false;
    using mounted = {
      wrapper: mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: { opener: undefined } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(mounted.wrapper.emitted('consumeModelSupportInvestigationRequest')).toEqual([[]]);
    expect(mounted.wrapper.find('[data-testid="model-support-investigation-modal-stub"]').exists()).toBe(false);
    expect(timingMocks.snapshot).not.toHaveBeenCalled();
  });

  it('does not restore focus to a disconnected sidebar opener', async () => {
    const opener = document.createElement('button');
    const focus = vi.spyOn(opener, 'focus');
    using mounted = {
      wrapper: mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: { opener } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
        focus.mockRestore();
      },
    };
    await flushPromises();
    await mounted.wrapper.get('[data-testid="model-support-investigation-close-stub"]').trigger('click');
    await flushPromises();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(['throws', 'malformed'] as const)('opens the investigation even when optional timing %s', async mode => {
    route.query = { settings: 'developer' };
    if (mode === 'throws') {
      timingMocks.snapshot.mockImplementation(() => {
        throw new Error('Timing unavailable');
      });
    } else {
      timingMocks.snapshot.mockReturnValue({ format: 'invalid' });
    }
    const wrapper = mount(AppAuxiliaryUi, { props: { pwaActivation: 'active', modelSupportInvestigationRequest: undefined } });
    await flushPromises();
    await wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').trigger('click');
    await flushPromises();
    const modal = wrapper.findComponent({ name: 'ModelSupportInvestigationModal' });
    expect(modal.exists()).toBe(true);
    expect(modal.props('ordinaryDownloadTiming')).toBeUndefined();
    wrapper.unmount();
  });
});
