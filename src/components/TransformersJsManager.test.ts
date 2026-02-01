import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import TransformersJsManager from './TransformersJsManager.vue';
import { transformersJsService } from '../services/transformers-js';
import * as opfsDetection from '../services/storage/opfs-detection';

// --- Mocks ---

vi.mock('../services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn(),
}));

vi.mock('@vueuse/core', async () => {
  const actual = await vi.importActual('@vueuse/core') as any;
  return {
    ...actual,
    computedAsync: (fn: any, initial: any) => {
      const state = ref(initial);
      const res = fn();
      if (res && typeof res.then === 'function') {
        res.then((val: any) => state.value = val);
      } else {
        state.value = res;
      }
      return state;
    }
  };
});

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

const mockAddToast = vi.fn();
vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
  }),
}));

const mockShowConfirm = vi.fn();
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Loader2: { template: '<span>Loader2</span>' },
  CheckCircle2: { template: '<span>CheckCircle2</span>' },
  AlertCircle: { template: '<span>AlertCircle</span>' },
  Download: { template: '<span>Download</span>' },
  FolderOpen: { template: '<span>FolderOpen</span>' },
  RefreshCcw: { template: '<span>RefreshCcw</span>' },
  Trash2: { template: '<span>Trash2</span>' },
  ChevronDown: { template: '<span>ChevronDown</span>' },
  Plus: { template: '<span>Plus</span>' },
  HardDriveDownload: { template: '<span>HardDriveDownload</span>' },
  X: { template: '<span>X</span>' },
  BrainCircuit: { template: '<span>BrainCircuit</span>' },
  PowerOff: { template: '<span>PowerOff</span>' },
  ExternalLink: { template: '<span>ExternalLink</span>' },
  Search: { template: '<span>Search</span>' },
  FileCode: { template: '<span>FileCode</span>' },
  RotateCcw: { template: '<span>RotateCcw</span>' },
}));

describe('TransformersJsManager.vue', () => {
  const mockState = {
    status: 'idle',
    progress: 0,
    error: null,
    activeModelId: null,
    device: 'wasm',
    isCached: false,
    isLoadingFromCache: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (transformersJsService.getState as any).mockReturnValue({ ...mockState });
    (transformersJsService.listCachedModels as any).mockResolvedValue([]);
    (transformersJsService.subscribe as any).mockImplementation((_cb: any) => {
      return () => {}; // Unsubscribe mock
    });
    
    // Default mock implementation
    vi.mocked(opfsDetection.checkOPFSSupport).mockResolvedValue(true);
    
    // Define global constant
    (global as any).__BUILD_MODE_IS_STANDALONE__ = false;
  });

  it('renders idle state correctly', async () => {
    const wrapper = mount(TransformersJsManager);

    expect(wrapper.text()).toContain('Engine Idle');
    expect(wrapper.text()).toContain('Load a model from the list below');
  });

  it('renders cached models', async () => {
    (transformersJsService.listCachedModels as any).mockResolvedValue([
      { id: 'hf.co/org/model1', size: 1024, fileCount: 5, lastModified: Date.now() }
    ]);

    const wrapper = mount(TransformersJsManager);
    await flushPromises();

    expect(wrapper.text()).toContain('hf.co/org/model1');
    expect(wrapper.text()).toContain('1 KB');
  });

  it('calls loadModel when Load button is clicked', async () => {
    (transformersJsService.listCachedModels as any).mockResolvedValue([
      { id: 'hf.co/org/model1', size: 1024, fileCount: 5, lastModified: Date.now() }
    ]);

    const wrapper = mount(TransformersJsManager);
    await flushPromises();

    const loadBtn = wrapper.find('button.bg-purple-50');
    await loadBtn.trigger('click');

    expect(transformersJsService.loadModel).toHaveBeenCalledWith('hf.co/org/model1');
  });

  it('calls unloadModel when PowerOff button is clicked', async () => {
    (transformersJsService.getState as any).mockReturnValue({
      ...mockState,
      status: 'ready',
      activeModelId: 'some-model'
    });

    const wrapper = mount(TransformersJsManager);
    await flushPromises();

    const unloadBtn = wrapper.find('button[title="Unload model and release resources"]');
    await unloadBtn.trigger('click');

    expect(transformersJsService.unloadModel).toHaveBeenCalled();
  });

  it('handles model deletion with confirmation', async () => {
    mockShowConfirm.mockResolvedValue(true);

    (transformersJsService.listCachedModels as any).mockResolvedValue([
      { id: 'hf.co/org/model1', size: 1024, fileCount: 5, lastModified: Date.now() }
    ]);

    const wrapper = mount(TransformersJsManager);
    await flushPromises();

    const deleteBtn = wrapper.find('button[title="Delete model"]');
    await deleteBtn.trigger('click');

    expect(mockShowConfirm).toHaveBeenCalled();
    expect(transformersJsService.deleteModel).toHaveBeenCalledWith('hf.co/org/model1');
  });

  it('shows progress bar during loading', async () => {
    (transformersJsService.getState as any).mockReturnValue({
      ...mockState,
      status: 'loading',
      progress: 45
    });

    const wrapper = mount(TransformersJsManager);

    expect(wrapper.text()).toContain('Initializing Engine...');
    expect(wrapper.text()).toContain('45%');
    
    const progressBar = wrapper.find('.bg-blue-600');
    expect(progressBar.attributes('style')).toContain('width: 45%');
  });

  describe('Standalone Mode', () => {
    it('does not show standalone warning in hosted mode', async () => {
      (global as any).__BUILD_MODE_IS_STANDALONE__ = false;
      const wrapper = mount(TransformersJsManager);
      
      expect(wrapper.text()).not.toContain('In-browser AI (Transformers.js) is not available in the Standalone build');
      
      const mainSection = wrapper.find('.animate-in.fade-in.slide-in-from-bottom-2');
      expect(mainSection.classes()).not.toContain('opacity-40');
    });

    it('renders with restrictions and warning in standalone mode', async () => {
      (global as any).__BUILD_MODE_IS_STANDALONE__ = true;
      const wrapper = mount(TransformersJsManager);
      
      // Standalone warning SHOULD be visible
      expect(wrapper.text()).toContain('In-browser AI (Transformers.js) is not available in the Standalone build');
      
      // Main content area SHOULD be visually disabled
      const mainSection = wrapper.find('.animate-in.fade-in.slide-in-from-bottom-2');
      expect(mainSection.classes()).toContain('opacity-40');
      expect(mainSection.classes()).toContain('pointer-events-none');
      expect(mainSection.classes()).toContain('grayscale');
      
      // GitHub Releases link should be present
      const externalLink = wrapper.find('a[href="https://github.com/nwtgck/naidan/releases"]');
      expect(externalLink.exists()).toBe(true);
      expect(externalLink.text()).toContain('Get Hosted Version (GitHub)');
    });

    it('displays the correct reason for unavailability in standalone mode', async () => {
      (global as any).__BUILD_MODE_IS_STANDALONE__ = true;
      const wrapper = mount(TransformersJsManager);
      
      expect(wrapper.text()).toContain('due to browser restrictions on Web Workers and WebAssembly');
    });
  });

  describe('OPFS Support', () => {
    it('shows warning when OPFS is not supported', async () => {
      (global as any).__BUILD_MODE_IS_STANDALONE__ = false;
      vi.mocked(opfsDetection.checkOPFSSupport).mockResolvedValue(false);
      
      const wrapper = mount(TransformersJsManager);
      await flushPromises();
      
      expect(wrapper.text()).toContain('the browser does not support or allow access to Origin Private File System (OPFS)');
      
      const mainSection = wrapper.find('.animate-in.fade-in.slide-in-from-bottom-2');
      expect(mainSection.classes()).toContain('opacity-40');
      expect(mainSection.classes()).toContain('pointer-events-none');
    });

    it('does not show OPFS warning when supported', async () => {
      (global as any).__BUILD_MODE_IS_STANDALONE__ = false;
      vi.mocked(opfsDetection.checkOPFSSupport).mockResolvedValue(true);
      
      const wrapper = mount(TransformersJsManager);
      await flushPromises();
      
      expect(wrapper.text()).not.toContain('the browser does not support or allow access to Origin Private File System (OPFS)');
      
      const mainSection = wrapper.find('.animate-in.fade-in.slide-in-from-bottom-2');
      expect(mainSection.classes()).not.toContain('opacity-40');
    });
  });
});
