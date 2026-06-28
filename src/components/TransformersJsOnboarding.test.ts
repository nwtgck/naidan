import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '@/composables/useSettings';
import { useTheme } from '@/composables/useTheme';
import { transformersJsService } from '@/services/transformers-js';
import TransformersJsManager from './TransformersJsManager.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// --- Mocks ---
const mockAddToast = vi.fn();
const mockShowConfirm = vi.fn().mockResolvedValue(true);

vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: vi.fn(),
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({ useSettings: vi.fn() }));
vi.mock('../composables/useToast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));
vi.mock('../composables/useTheme', () => ({ useTheme: vi.fn() }));
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

const mockSetActiveFocusArea = vi.fn();
vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
  }),
}));

vi.mock('../services/transformers-js', () => ({
  transformersJsService: {
    getState: vi.fn(),
    subscribe: vi.fn(),
    subscribeModelList: vi.fn().mockReturnValue(() => {}),
    listCachedModels: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
    restart: vi.fn(),
    downloadModel: vi.fn(),
    deleteModel: vi.fn(),
    importFile: vi.fn(),
  },
}));

// Mock Lucide icons used in OnboardingModal and TransformersJsManager
vi.mock('lucide-vue-next', () => ({
  PlayIcon: { template: '<span>Play</span>' },
  ArrowLeftIcon: { template: '<span>ArrowLeft</span>' },
  CheckCircle2Icon: { template: '<span>CheckCircle2</span>' },
  ActivityIcon: { template: '<span>Activity</span>' },
  SettingsIcon: { template: '<span>Settings</span>' },
  XIcon: { template: '<span>X</span>' },
  PlusIcon: { template: '<span>Plus</span>' },
  Trash2Icon: { template: '<span>Trash2</span>' },
  FlaskConicalIcon: { template: '<span>FlaskConical</span>' },
  Loader2Icon: { template: '<span>Loader2</span>' },
  AlertCircleIcon: { template: '<span>AlertCircle</span>' },
  DownloadIcon: { template: '<span>Download</span>' },
  FolderOpenIcon: { template: '<span>FolderOpen</span>' },
  RefreshCcwIcon: { template: '<span>RefreshCcw</span>' },
  GlobeIcon: { template: '<span>Globe</span>' },
  ChevronDownIcon: { template: '<span>ChevronDown</span>' },
  HardDriveDownloadIcon: { template: '<span>HardDriveDownload</span>' },
  BrainCircuitIcon: { template: '<span>BrainCircuit</span>' },
  PowerOffIcon: { template: '<span>PowerOff</span>' },
  ExternalLinkIcon: { template: '<span>ExternalLink</span>' },
  SearchIcon: { template: '<span>Search</span>' },
  FileCodeIcon: { template: '<span>FileCode</span>' },
  RotateCcwIcon: { template: '<span>RotateCcw</span>' },
  SunIcon: { template: '<span>Sun</span>' },
  MoonIcon: { template: '<span>Moon</span>' },
  MonitorIcon: { template: '<span>Monitor</span>' },
  CopyIcon: { template: '<span>Copy</span>' },
  CheckIcon: { template: '<span>Check</span>' },
}));

describe('Transformers.js Onboarding Integration', () => {
  const mockSave = vi.fn();
  const mockSettings = { value: { endpointType: 'openai', autoTitleEnabled: true } };
  const mockIsOnboardingDismissed = ref(false);
  const mockOnboardingDraft = ref<any>(null);

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockIsOnboardingDismissed.value = false;
    mockOnboardingDraft.value = null;
    (useSettings as unknown as Mock).mockReturnValue({
      settings: mockSettings,
      save: mockSave,
      initialized: { value: true },
      isOnboardingDismissed: mockIsOnboardingDismissed,
      onboardingDraft: mockOnboardingDraft,
      availableModels: ref([]),
      isFetchingModels: ref(false),
      fetchModels: vi.fn(),
      setIsOnboardingDismissed: ({ dismissed }: { dismissed: boolean }) => {
        mockIsOnboardingDismissed.value = dismissed;
      },
      setOnboardingDraft: ({ draft }: { draft: any }) => {
        mockOnboardingDraft.value = draft;
      },
    });

    (useTheme as unknown as Mock).mockReturnValue({
      themeMode: { value: 'system' },
      setTheme: vi.fn(),
    });

    (transformersJsService.getState as any).mockReturnValue({
      status: 'idle',
      progress: 0,
      error: undefined,
      activeModelId: undefined,
      device: 'wasm',
      isCached: false,
      isLoadingFromCache: false,
      progressItems: new Map(),
    });
    (transformersJsService.listCachedModels as any).mockResolvedValue([]);
    (transformersJsService.subscribe as any).mockImplementation(({ listener }: any) => {
      // Immediate call for the first state
      listener({ status: 'idle', progress: 0, error: undefined, isCached: false, isLoadingFromCache: false, progressItems: new Map() });
      return () => {};
    });

    (global as any).__BUILD_MODE_IS_STANDALONE__ = false;
  });

  const mountModal = (options = {}) => {
    return mount(OnboardingModal, {
      global: {
        stubs: {
          // Stub it but keep functionality we need to test integration
          TransformersJsManager: {
            name: 'TransformersJsManager',
            template: '<div class="transformers-js-manager-stub"><button class="mock-load-btn" @click="$emit(\'model-loaded\', \'downloaded-model\')">Mock Load</button></div>',
            emits: ['model-loaded'],
          },
        },
        ...((options as any).global || {}),
      },
      ...options,
    });
  };

  it('hides right column and expands left column when Transformers.js is selected', async () => {
    const wrapper = mountModal();

    // Switch to Transformers.js
    let tfBtn: ReturnType<typeof wrapper.findAll>[number] | undefined;
    await vi.waitFor(() => {
      tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
      expect(tfBtn).toBeDefined();
    });
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    // Right column (guide) should be hidden
    expect(wrapper.find('div[class*="lg:w-[38%]"]').exists()).toBe(false);

    // Left column should be full width
    const leftCol = wrapper.find('div[class*="p-6 md:p-10"]');
    expect(leftCol.classes()).toContain('w-full');
  });

  it('renders Experimental badge and Transformers.js Manager in the integrated view', async () => {
    const wrapper = mountModal();
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.text()).toContain('In-Browser AI');
    expect(wrapper.text()).toContain('Experimental');
    expect(wrapper.findComponent({ name: 'TransformersJsManager' }).exists()).toBe(true);
  });

  it('disables "Get Started" button when no model is active in Transformers.js mode', async () => {
    const wrapper = mountModal();
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    expect((getStartedBtn?.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables "Get Started" button when a model is loaded via service subscription', async () => {
    let subscriberCallback: any;
    (transformersJsService.subscribe as any).mockImplementation(({ listener }: any) => {
      subscriberCallback = listener;
      listener({ status: 'idle', progress: 0, error: null, isCached: false, isLoadingFromCache: false });
      return () => {};
    });

    const wrapper = mountModal();
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();

    // Mock engine becoming ready with a model
    (transformersJsService.getState as any).mockReturnValue({
      status: 'ready',
      activeModelId: 'some-model-id',
    });
    // Trigger the callback that service would trigger
    subscriberCallback({ status: 'ready', progress: 100, error: null, isCached: true, isLoadingFromCache: true });
    await flushPromises();
    await nextTick();

    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    expect((getStartedBtn?.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('automatically loads the most recently modified model when switching to Transformers.js tab', async () => {
    (transformersJsService.listCachedModels as any).mockResolvedValue([
      { id: 'old-model', lastModified: 1000, isComplete: true },
      { id: 'new-model', lastModified: 2000, isComplete: true },
    ]);

    const wrapper = mountModal();
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    expect(transformersJsService.loadModel).toHaveBeenCalledWith({ modelId: 'new-model' });
  });

  it('updates selectedModel when TransformersJsManager emits model-loaded', async () => {
    const wrapper = mountModal();
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    const manager = wrapper.getComponent({ name: 'TransformersJsManager' });
    await manager.find('.mock-load-btn').trigger('click');
    await nextTick();

    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    expect((getStartedBtn?.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves correct settings when "Get Started" is clicked in Transformers.js mode', async () => {
    const wrapper = mountModal();

    // Switch to TF.js
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();
    await nextTick();

    // Mock a model loaded via emit
    const manager = wrapper.getComponent({ name: 'TransformersJsManager' });
    await manager.find('.mock-load-btn').trigger('click');
    await nextTick();

    // Click Get Started
    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    await getStartedBtn?.trigger('click');
    await flushPromises();

    expect(mockSave).toHaveBeenCalledWith({
      patch: expect.objectContaining({
        endpointType: 'transformers_js',
        defaultModelId: 'downloaded-model',
      }),
      modelRefresh: 'await',
    });
  });

  it('automatically loads model after successful download in TransformersJsManager (Integrated flow)', async () => {
    // This test uses the real component but mocks the service
    const wrapper = mount(OnboardingModal);
    await flushPromises();

    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    expect(tfBtn).toBeDefined();
    await tfBtn!.trigger('click');
    await flushPromises();

    const manager = wrapper.getComponent(TransformersJsManager);

    // Simulate typing a model ID
    const input = manager.find('input[placeholder*="Enter Hugging Face model ID"]');
    await input.setValue('new-download-model');

    // Click download button
    const downloadBtn = manager.findAll('button').find(b => b.text().includes('Download Model'));
    await downloadBtn?.trigger('click');

    expect(transformersJsService.downloadModel).toHaveBeenCalledWith({ modelId: 'new-download-model' });

    // Wait for download to finish
    await flushPromises();

    // Should have automatically called loadModel (logic is inside TransformersJsManager)
    expect(transformersJsService.loadModel).toHaveBeenCalledWith({ modelId: 'new-download-model' });
  });
});
