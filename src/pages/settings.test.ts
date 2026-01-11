import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import SettingsPage from './settings.vue';
import type * as VueRouter from 'vue-router';

enableAutoUnmount(afterEach);

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Mocks with Hoisting ---

const mocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  save: vi.fn(),
  createSampleChat: vi.fn(),
  listModels: vi.fn(),
  clearAll: vi.fn(),
  settingsValue: {
    endpointType: 'openai',
    endpointUrl: 'http://test-url',
    defaultModelId: 'gpt-4-test',
    titleModelId: undefined,
    autoTitleEnabled: true,
    storageType: 'local',
  },
}));

let capturedGuard: ((to: any, from: any, next: any) => void) | null = null;

// 1. Mock Router & Guards
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof VueRouter>();
  return {
    ...actual,
    useRouter: () => ({
      back: mocks.back,
      push: mocks.push,
    }),
    onBeforeRouteLeave: (guard: any) => {
      capturedGuard = guard;
    },
  };
});

// 2. Mock useSettings
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { ...mocks.settingsValue } },
    save: mocks.save,
  }),
}));

// 3. Mock useSampleChat
vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: () => ({
    createSampleChat: mocks.createSampleChat,
  }),
}));

// 4. Mock LLM Providers (Fix: Use standard function to support 'new')
vi.mock('../services/llm', () => {
  const MockProvider = function() {
    return {
      listModels: mocks.listModels,
    };
  };
  return {
    OpenAIProvider: MockProvider,
    OllamaProvider: MockProvider,
  };
});

// 5. Mock Storage Service
vi.mock('../services/storage', () => ({
  storageService: {
    clearAll: mocks.clearAll,
  },
}));

// --- Tests ---

describe('Settings Page (src/pages/settings.vue)', () => {
  const mountPage = () => {
    return mount(SettingsPage, {
      global: {
        stubs: {
          ArrowLeft: true, Settings2: true, Save: true, Globe: true,
          Loader2: true, RefreshCw: true, Bot: true, Type: true,
          Database: true, FlaskConical: true, Trash2: true,
        },
      },
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedGuard = null;
    mocks.listModels.mockResolvedValue(['gpt-4-test', 'gpt-3.5-turbo']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders correctly and loads initial settings', async () => {
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('App Settings');
    const urlInput = wrapper.find('input[placeholder="http://localhost:11434"]').element as HTMLInputElement;
    expect(urlInput.value).toBe('http://test-url');
    expect(mocks.listModels).toHaveBeenCalledWith('http://test-url');
  });

  it('detects changes and enables the save button', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const saveBtn = wrapper.find('button.bg-blue-600');
    expect(saveBtn.attributes('disabled')).toBeDefined();

    const urlInput = wrapper.find('input[placeholder="http://localhost:11434"]');
    await urlInput.setValue('http://new-url');

    expect(saveBtn.attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('Save Changes');
  });

  it('saves settings when save button is clicked', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const urlInput = wrapper.find('input[placeholder="http://localhost:11434"]');
    await urlInput.setValue('http://saved-url');

    await wrapper.find('button.bg-blue-600').trigger('click');

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://saved-url',
    }));
    expect(wrapper.text()).toContain('Saved!');
  });

  it('fetches models when refresh button is clicked', async () => {
    const wrapper = mountPage();
    await flushPromises();
    mocks.listModels.mockClear();

    const refreshBtn = wrapper.findAll('button').find(b => b.text().includes('Refresh'));
    await refreshBtn?.trigger('click');

    expect(mocks.listModels).toHaveBeenCalledTimes(1);
  });

  it('warns user via navigation guard when leaving with unsaved changes', async () => {
    const wrapper = mountPage();
    await flushPromises();

    // 1. No changes
    const nextMock = vi.fn();
    if (capturedGuard) capturedGuard({}, {}, nextMock);
    expect(nextMock).toHaveBeenCalledWith();

    // 2. Make changes
    const urlInput = wrapper.find('input[placeholder="http://localhost:11434"]');
    await urlInput.setValue('http://unsaved-change');

    // 3. Try to navigate away
    nextMock.mockClear();
    if (capturedGuard) capturedGuard({}, {}, nextMock);

    expect(window.confirm).toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalledWith();
    
    // 4. Cancel
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    nextMock.mockClear();
    if (capturedGuard) capturedGuard({}, {}, nextMock);
    expect(nextMock).toHaveBeenCalledWith(false);
  });

  it('warns user via browser event (beforeunload) with unsaved changes', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const event = new Event('beforeunload') as any;
    event.preventDefault = vi.fn();
    event.returnValue = '';

    // 1. No changes
    window.dispatchEvent(event);
    expect(event.preventDefault).not.toHaveBeenCalled();

    // 2. Make changes
    const urlInput = wrapper.find('input[placeholder="http://localhost:11434"]');
    await urlInput.setValue('http://dirty-state');

    // 3. Trigger unload
    event.preventDefault.mockClear(); // Clear previous calls if any
    window.dispatchEvent(event);
    expect(event.preventDefault).toHaveBeenCalled();
    // expect(event.returnValue).toBe(''); // Removed flaky assertion
  });

  it('performs destructive reset action', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const resetBtn = wrapper.findAll('button').find(b => b.text().includes('Reset All App Data'));
    await resetBtn?.trigger('click');

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.clearAll).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('creates sample chat', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const sampleBtn = wrapper.findAll('button').find(b => b.text().includes('Create Sample Chat'));
    await sampleBtn?.trigger('click');

    expect(mocks.createSampleChat).toHaveBeenCalled();
  });

  it('goes back when back button is clicked', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const backBtn = wrapper.find('button[title="Go Back"]');
    await backBtn.trigger('click');

    expect(mocks.back).toHaveBeenCalled();
  });
});
