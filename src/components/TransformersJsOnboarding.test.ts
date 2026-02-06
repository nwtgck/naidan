import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '../composables/useSettings';
import { useTheme } from '../composables/useTheme';
import { transformersJsService } from '../services/transformers-js';
import TransformersJsManager from './TransformersJsManager.vue';

// --- Mocks ---
const mockAddToast = vi.fn();
const mockShowConfirm = vi.fn().mockResolvedValue(true);

vi.mock('../services/llm', () => ({
  OpenAIProvider: vi.fn(),
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
    listCachedModels: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
    restart: vi.fn(),
    downloadModel: vi.fn(),
    deleteModel: vi.fn(),
    importFile: vi.fn(),
  }
}));

// Mock Lucide icons used in OnboardingModal and TransformersJsManager
vi.mock('lucide-vue-next', () => ({
  Play: { template: '<span>Play</span>' },
  ArrowLeft: { template: '<span>ArrowLeft</span>' },
  CheckCircle2: { template: '<span>CheckCircle2</span>' },
  Activity: { template: '<span>Activity</span>' },
  Settings: { template: '<span>Settings</span>' },
  X: { template: '<span>X</span>' },
  Plus: { template: '<span>Plus</span>' },
  Trash2: { template: '<span>Trash2</span>' },
  FlaskConical: { template: '<span>FlaskConical</span>' },
  Loader2: { template: '<span>Loader2</span>' },
  AlertCircle: { template: '<span>AlertCircle</span>' },
  Download: { template: '<span>Download</span>' },
  FolderOpen: { template: '<span>FolderOpen</span>' },
  RefreshCcw: { template: '<span>RefreshCcw</span>' },
  ChevronDown: { template: '<span>ChevronDown</span>' },
  HardDriveDownload: { template: '<span>HardDriveDownload</span>' },
  BrainCircuit: { template: '<span>BrainCircuit</span>' },
  PowerOff: { template: '<span>PowerOff</span>' },
  ExternalLink: { template: '<span>ExternalLink</span>' },
  Search: { template: '<span>Search</span>' },
  FileCode: { template: '<span>FileCode</span>' },
  RotateCcw: { template: '<span>RotateCcw</span>' },
  Sun: { template: '<span>Sun</span>' },
  Moon: { template: '<span>Moon</span>' },
  Monitor: { template: '<span>Monitor</span>' },
  Copy: { template: '<span>Copy</span>' },
  Check: { template: '<span>Check</span>' },
}));

describe('Transformers.js Onboarding Integration', () => {
  const mockSave = vi.fn();
  const mockSettings = { value: { endpointType: 'openai', autoTitleEnabled: true } };
  const mockIsOnboardingDismissed = ref(false);
  const mockOnboardingDraft = ref<any>(null);

  beforeEach(() => {
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
      setIsOnboardingDismissed: (val: boolean) => {
        mockIsOnboardingDismissed.value = val; 
      },
      setOnboardingDraft: (val: any) => {
        mockOnboardingDraft.value = val; 
      },
    });

    (useTheme as unknown as Mock).mockReturnValue({
      themeMode: { value: 'system' },
      setTheme: vi.fn(),
    });

    (transformersJsService.getState as any).mockReturnValue({
      status: 'idle',
      progress: 0,
      error: null,
      activeModelId: null,
      device: 'wasm',
      isCached: false,
      isLoadingFromCache: false,
    });
    (transformersJsService.listCachedModels as any).mockResolvedValue([]);
    (transformersJsService.subscribe as any).mockImplementation((cb: any) => {
      // Immediate call for the first state
      cb('idle', 0, null, false, false);
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
            emits: ['model-loaded']
          }
        },
        ...((options as any).global || {})
      },
      ...options
    });
  };

  it('hides right column and expands left column when Transformers.js is selected', async () => {
    const wrapper = mountModal();
    
    // Switch to Transformers.js
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await nextTick();

    // Right column (guide) should be hidden
    expect(wrapper.find('div[class*="lg:w-[38%]"]').exists()).toBe(false);
    
    // Left column should be full width
    const leftCol = wrapper.find('div[class*="p-6 md:p-10"]');
    expect(leftCol.classes()).toContain('w-full');
  });

  it('renders Experimental badge and Transformers.js Manager in the integrated view', async () => {
    const wrapper = mountModal();
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('In-Browser AI');
    expect(wrapper.text()).toContain('Experimental');
    expect(wrapper.findComponent({ name: 'TransformersJsManager' }).exists()).toBe(true);
  });

  it('disables "Get Started" button when no model is active in Transformers.js mode', async () => {
    const wrapper = mountModal();
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await nextTick();

    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    expect((getStartedBtn?.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables "Get Started" button when a model is loaded via service subscription', async () => {
    let subscriberCallback: any;
    (transformersJsService.subscribe as any).mockImplementation((cb: any) => {
      subscriberCallback = cb;
      cb('idle', 0, null, false, false);
      return () => {};
    });

    const wrapper = mountModal();
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await flushPromises();

    // Mock engine becoming ready with a model
    (transformersJsService.getState as any).mockReturnValue({
      status: 'ready',
      activeModelId: 'some-model-id'
    });
    // Trigger the callback that service would trigger
    subscriberCallback('ready', 100, null, true, true);
    await flushPromises();
    await nextTick();

    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    expect((getStartedBtn?.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('automatically loads the most recently modified model when switching to Transformers.js tab', async () => {
    (transformersJsService.listCachedModels as any).mockResolvedValue([
      { id: 'old-model', lastModified: 1000 },
      { id: 'new-model', lastModified: 2000 },
    ]);

    const wrapper = mountModal();
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await flushPromises();
    await nextTick();

    expect(transformersJsService.loadModel).toHaveBeenCalledWith('new-model');
  });

  it('updates selectedModel when TransformersJsManager emits model-loaded', async () => {
    const wrapper = mountModal();
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
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
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await nextTick();

    // Mock a model loaded via emit
    const manager = wrapper.getComponent({ name: 'TransformersJsManager' });
    await manager.find('.mock-load-btn').trigger('click');
    await nextTick();

    // Click Get Started
    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'));
    await getStartedBtn?.trigger('click');
    await flushPromises();

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      endpointType: 'transformers_js',
      defaultModelId: 'downloaded-model'
    }));
  });

  it('automatically loads model after successful download in TransformersJsManager (Integrated flow)', async () => {
    // This test uses the real component but mocks the service
    const wrapper = mount(OnboardingModal);
    
    const tfBtn = wrapper.findAll('button').find(b => b.text().includes('Transformers.js'));
    await tfBtn?.trigger('click');
    await flushPromises();

    const manager = wrapper.getComponent(TransformersJsManager);
    
    // Simulate typing a model ID
    const input = manager.find('input[placeholder*="Enter Hugging Face model ID"]');
    await input.setValue('new-download-model');
    
    // Click download button
    const downloadBtn = manager.findAll('button').find(b => b.text().includes('Download Model'));
    await downloadBtn?.trigger('click');

    expect(transformersJsService.downloadModel).toHaveBeenCalledWith('new-download-model');
    
    // Wait for download to finish
    await flushPromises();
    
    // Should have automatically called loadModel (logic is inside TransformersJsManager)
    expect(transformersJsService.loadModel).toHaveBeenCalledWith('new-download-model');
  });
});