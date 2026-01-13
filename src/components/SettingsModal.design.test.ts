import { ref } from 'vue';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { usePrompt } from '../composables/usePrompt';
import { useSampleChat } from '../composables/useSampleChat';

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));
vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));
vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(),
}));
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));
vi.mock('../composables/usePrompt', () => ({
  usePrompt: vi.fn(),
}));
vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

describe('SettingsModal Design Specifications', () => {
  beforeEach(() => {
    (useSettings as unknown as Mock).mockReturnValue({
      settings: ref({ providerProfiles: [] }),
      availableModels: ref([]),
      isFetchingModels: ref(false),
      save: vi.fn(),
      fetchModels: vi.fn(),
    });
    (useChat as unknown as Mock).mockReturnValue({
      deleteAllChats: vi.fn(),
    });
    (useToast as unknown as Mock).mockReturnValue({
      addToast: vi.fn(),
    });
    (useConfirm as unknown as Mock).mockReturnValue({
      showConfirm: vi.fn(),
    });
    (usePrompt as unknown as Mock).mockReturnValue({
      showPrompt: vi.fn(),
    });
    (useSampleChat as unknown as Mock).mockReturnValue({
      createSampleChat: vi.fn(),
    });
  });

  it('uses a layered sidebar with bg-gray-50/50 for contrast', () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    const aside = wrapper.find('aside');
    expect(aside.classes()).toContain('bg-gray-50/50');
    expect(aside.classes()).toContain('border-gray-100');
  });

  it('uses rounded-3xl for the main modal container to give a modern feel', () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    const modalContainer = wrapper.find('.rounded-3xl');
    expect(modalContainer.exists()).toBe(true);
  });

  it('uses capitalized labels for Provider Profiles (with uppercase class)', async () => {
    // Inject a profile to check the badge
    (useSettings as unknown as Mock).mockReturnValue({
      settings: ref({ 
        providerProfiles: [{ id: '1', name: 'Profile-1', endpointType: 'ollama', endpointUrl: '...' }], 
      }),
      availableModels: ref([]),
      isFetchingModels: ref(false),
      save: vi.fn(),
      fetchModels: vi.fn(),
    });
    
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    // Switch to profiles tab (the second button)
    const profilesTab = wrapper.findAll('nav button')[1];
    await profilesTab?.trigger('click');
    
    // Check capitalization in badge
    const badge = wrapper.find('[data-testid="provider-type-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('Ollama');
    expect(badge.classes()).toContain('uppercase');
  });

  it('uses blue-600 shadow for the save button to indicate primary action', () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    const saveBtn = wrapper.find('[data-testid="setting-save-button"]');
    expect(saveBtn.classes()).toContain('bg-blue-600');
    expect(saveBtn.classes()).toContain('shadow-blue-500/30');
  });

  it('displays the critical "only for localhost" notice in the Connection tab', () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    // By default, it opens on the Connection tab.
    expect(wrapper.text()).toContain('Connection check is automatically performed only for localhost URLs.');
  });

  describe('Tab Switching Visual Stability (Flash Prevention)', () => {
    it('uses transition-colors on tab buttons to prevent shadow/border interpolation flash', () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      const tabButtons = wrapper.findAll('nav button');
      
      tabButtons.forEach(button => {
        expect(button.classes()).toContain('transition-colors');
        expect(button.classes()).not.toContain('transition-all');
      });
    });

    it('maintains a constant border class to prevent layout shift or border-flicker', () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      const tabButtons = wrapper.findAll('nav button');
      
      tabButtons.forEach(button => {
        expect(button.classes()).toContain('border');
      });
    });

    it('uses border-transparent for inactive tabs to ensure smooth activation', async () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      // Initially, 'connection' is active. Check other tabs.
      const profilesTab = wrapper.findAll('nav button')[1];
      expect(profilesTab?.classes()).toContain('border-transparent');
      
      // When activated, it should get a visible border but not lose the 'border' class
      await profilesTab?.trigger('click');
      expect(profilesTab?.classes()).toContain('border-gray-100');
      expect(profilesTab?.classes()).not.toContain('border-transparent');
    });
  });
});
