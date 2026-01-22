import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RecipeExportModal from './RecipeExportModal.vue';

describe('RecipeExportModal.vue', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      randomUUID: () => Math.random().toString(36).substring(2),
    });
  });

  const defaultProps = {
    isOpen: true,
    groupName: 'Test Group',
    systemPrompt: { content: 'System instruction', behavior: 'override' as const },
    lmParameters: { temperature: 0.7 },
    initialModelId: 'llama3:8b'
  };

  it('renders correctly when open', () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    expect(wrapper.text()).toContain('Recipe Editor');
    expect((wrapper.find('input[type="text"]').element as HTMLInputElement).value).toBe('Test Group');
  });

  it('generates intelligent initial regex from initialModelId', async () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    // Manually trigger init because watch immediate: true isn't used
    (wrapper.vm as any).initForm();
    await nextTick();

    expect(wrapper.text()).toContain('Regex');
    const inputs = wrapper.findAll('input.font-mono');
    expect(inputs.length).toBeGreaterThan(1);
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('^llama3:8b$');
  });

  it('allows adding and removing model patterns', async () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    (wrapper.vm as any).initForm();
    await nextTick();
    
    let inputs = wrapper.findAll('input.font-mono');
    const initialCount = inputs.length;
    expect(initialCount).toBeGreaterThan(0);

    const addButton = wrapper.findAll('button').find(b => b.text().includes('Add Rule'));
    expect(addButton?.exists()).toBe(true);
    await addButton?.trigger('click');
    await nextTick();
    
    inputs = wrapper.findAll('input.font-mono');
    expect(inputs.length).toBe(initialCount + 1);

    const deleteButton = wrapper.findAll('button').find(b => b.find('svg.lucide-trash2').exists() || b.html().includes('lucide-trash2'));
    await deleteButton?.trigger('click');
    await nextTick();
    
    inputs = wrapper.findAll('input.font-mono');
    expect(inputs.length).toBe(initialCount);
  });

  it('updates JSON preview in real-time when editing fields', async () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    (wrapper.vm as any).initForm();
    await nextTick();

    const nameInput = wrapper.find('input[type="text"]');
    await nameInput.setValue('Updated Recipe Name');
    
    const preview = wrapper.find('pre');
    expect(preview.text()).toContain('"name": "Updated Recipe Name"');
    expect(preview.text()).toContain('"temperature": 0.7');
  });

  it('toggles case sensitivity for regex rules', async () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    (wrapper.vm as any).initForm();
    await nextTick();

    const caseToggle = wrapper.find('button[title="Toggle Case Sensitivity"]');
    
    // Default is case-insensitive (has 'i' flag in JSON)
    expect(wrapper.find('pre').text()).toContain(`"flags": [
        "i"
      ]`);

    await caseToggle.trigger('click');
    await nextTick();
    
    // Now case-sensitive (empty flags array)
    expect(wrapper.find('pre').text()).toContain('"flags": []');
  });

  it('validates regex patterns', async () => {
    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });
    (wrapper.vm as any).initForm();
    await nextTick();

    const regexInput = wrapper.find('input.font-mono');
    await regexInput.setValue('['); // Invalid regex
    await nextTick();
    
    expect(wrapper.text()).toContain('Invalid Regular Expression');
    expect(wrapper.find('.border-red-300').exists()).toBe(true);
  });

  it('copies JSON to clipboard and shows feedback', async () => {
    // Mock clipboard API
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText }
    });

    const wrapper = mount(RecipeExportModal, {
      props: defaultProps,
    });

    const copyBtn = wrapper.find('[data-testid="recipe-export-copy-button"]');
    await copyBtn.trigger('click');

    expect(writeText).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Copied to Clipboard!');
  });
});
