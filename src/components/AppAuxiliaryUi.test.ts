import { START_LOCATION } from 'vue-router';
import { shallowRef } from 'vue';
import { TEST_ONLY as modelPresetTestOnly, type ModelPreset } from '@/features/llama-cpp-browser/model-preset';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, useRouter } from 'vue-router';
import AppAuxiliaryUi from './AppAuxiliaryUi.vue';
import type { DownloadTimingSnapshot } from '@/features/transformers-js/download-timing';

const timingMocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('@/features/transformers-js', () => ({ transformersJsService: { getDownloadTimingSnapshot: timingMocks.snapshot } }));

function timingSnapshot(): DownloadTimingSnapshot {
  return { format: 'transformers-js-download-timing-v1', measurementVersion: 1, source: 'ordinary-download',
    serviceEpoch: '11111111-1111-4111-8111-111111111111', identityStatus: 'available', sequence: 1,
    availability: 'recorded', droppedOperations: 0,
    records: [{ operationId: '11111111-1111-4111-8111-111111111111/1', modelId: 'org/previous', runtimeEpoch: 1, outcome: 'failed',
      timingStatus: 'measured', wallMs: 100, truncated: false, droppedObservations: 0, observations: [] }] };
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
  isModelSupportInvestigationAvailable: true,
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
    props: ['isOpen'],
    emits: ['close', 'openModelSupportInvestigation'],
    template: '<div v-if="isOpen" data-testid="settings-modal"><button data-testid="settings-open-model-support-investigation-stub" @click="$emit(\'openModelSupportInvestigation\', \'\')">open</button></div>',
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
    push.mockClear(); replace.mockClear();
    timingMocks.snapshot.mockReset().mockReturnValue(undefined);
    isSearchOpen.value = false;
    isRecentOpen.value = false;
    vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
    vi.mocked(useRouter).mockReturnValue({ push, replace, currentRoute: shallowRef(route) } as unknown as ReturnType<typeof useRouter>);
  });

  it('opens the preset settings tab once while preserving unrelated query state', async () => {
    route.query = { 'llama-cpp-browser-model': 'hf.co/owner/repo:Q4_K_M', leaf: 'message-1' };
    const preset = shallowRef<ModelPreset>({ input: route.query['llama-cpp-browser-model']!, target: 'settings', claim: () => true });
    const wrapper = mount(AppAuxiliaryUi, { global: { provide: { [modelPresetTestOnly.presetKey as symbol]: preset } } });
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ path: '/', query: { ...route.query, settings: 'llama-cpp-browser' }, hash: undefined });
    route.query = { ...route.query, settings: 'llama-cpp-browser' }; await flushPromises();
    wrapper.vm.TEST_ONLY.closeSettings();
    expect(push).toHaveBeenCalledWith({ path: '/', query: { 'llama-cpp-browser-model': 'hf.co/owner/repo:Q4_K_M', leaf: 'message-1' } });
    delete route.query.settings; await flushPromises(); expect(replace).toHaveBeenCalledTimes(1);
    preset.value = { input: 'hf.co/owner/repo:Q8_0', target: 'settings', claim: () => true }; await flushPromises();
    expect(replace).toHaveBeenCalledTimes(2); wrapper.unmount();
  });
  it('preserves the pending cold-link path and query before initial navigation settles', async () => {
    const pendingRoute = { path: '/chat/chat-1', query: { leaf: 'message-2', 'llama-cpp-browser-model': 'hf.co/owner/repo' }, hash: '' };
    vi.mocked(useRouter).mockReturnValue({ push, replace, currentRoute: shallowRef(START_LOCATION), options: { history: { location: '/chat/chat-1?leaf=message-2' } }, resolve: vi.fn().mockReturnValue(pendingRoute) } as unknown as ReturnType<typeof useRouter>);
    const preset = shallowRef<ModelPreset>({ input: 'hf.co/owner/repo', target: 'settings', claim: () => true });
    const wrapper = mount(AppAuxiliaryUi, { global: { provide: { [modelPresetTestOnly.presetKey as symbol]: preset } } });
    await flushPromises(); expect(replace).toHaveBeenCalledWith({ ...pendingRoute, query: { ...pendingRoute.query, settings: 'llama-cpp-browser' } }); wrapper.unmount();
  });
  it('does not open settings for a preset assigned to ordinary onboarding', async () => {
    const preset = shallowRef<ModelPreset>({ input: 'hf.co/owner/repo', target: 'onboarding', claim: () => true });
    const wrapper = mount(AppAuxiliaryUi, { global: { provide: { [modelPresetTestOnly.presetKey as symbol]: preset } } });
    await flushPromises(); expect(replace).not.toHaveBeenCalled(); wrapper.unmount();
  });
  it('does not mount closed auxiliary overlays', async () => {
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
  });

  it('opens settings after post-startup UI is activated', async () => {
    route.query = { settings: '1' };
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();

    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('hands model support investigation off to the app-level host without destroying settings state', async () => {
    route.query = { settings: 'developer' };
    route.fullPath = '/?settings=developer';
    const wrapper = mount(AppAuxiliaryUi, { attachTo: document.body });
    await flushPromises();

    const settingsHost = wrapper.get('[data-testid="settings-modal-host"]');
    expect(settingsHost.element.getAttribute('style') ?? '').not.toContain('display: none');

    const opener = wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').element as HTMLElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="settings-modal-host"]').element.getAttribute('style')).toContain('display: none');
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
    const wrapper = mount(AppAuxiliaryUi);

    (wrapper.vm as unknown as { TEST_ONLY: { closeSettings(): void } }).TEST_ONLY.closeSettings();

    expect(push).toHaveBeenCalledWith('/chat/chat-1?leaf=message-1');
  });

  it('passes a detached ordinary-service snapshot at modal admission', async () => {
    route.query = { settings: 'developer' };
    const source = timingSnapshot();
    timingMocks.snapshot.mockReturnValue(source);
    const wrapper = mount(AppAuxiliaryUi);
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

  it.each(['throws', 'malformed'] as const)('opens the investigation even when optional timing %s', async mode => {
    route.query = { settings: 'developer' };
    if (mode === 'throws') timingMocks.snapshot.mockImplementation(() => {
      throw new Error('Timing unavailable');
    });
    else timingMocks.snapshot.mockReturnValue({ format: 'invalid' });
    const wrapper = mount(AppAuxiliaryUi);
    await flushPromises();
    await wrapper.get('[data-testid="settings-open-model-support-investigation-stub"]').trigger('click');
    await flushPromises();
    const modal = wrapper.findComponent({ name: 'ModelSupportInvestigationModal' });
    expect(modal.exists()).toBe(true);
    expect(modal.props('ordinaryDownloadTiming')).toBeUndefined();
    wrapper.unmount();
  });
});
