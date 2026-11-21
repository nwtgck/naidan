import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DOMWrapper, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RecipeImportTab from './RecipeImportTab.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('RecipeImportTab.vue', () => {
  const mockModels = ['provider/llama3', 'gpt-4'];

  it('renders correctly with empty state', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels, modelAvailability: 'remote' },
    });
    expect(wrapper.find('[data-testid="recipe-json-input"]').exists()).toBe(true);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Recipes');
    });
  });

  it('automatically analyzes JSON input and displays recipe list', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels, modelAvailability: 'remote' },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    const recipe = {
      type: 'chat_group_recipe',
      name: 'Test Recipe',
      models: [{ type: 'regex', pattern: 'llama3', flags: ['i'] }],
    };

    await textarea.setValue(JSON.stringify(recipe));
    await nextTick();

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Detected Recipes (1)');
    });
    expect((wrapper.find('input[placeholder="Chat Group Name"]').element as HTMLInputElement).value).toBe('Test Recipe');
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    expect(trigger.attributes('title')).toBe('provider/llama3');
    const metadata = trigger.get('[data-testid="model-selector-trigger-metadata"]');
    expect(metadata.element.previousElementSibling?.textContent).toBe('llama3');
    expect(metadata.text()).toBe('provider');
  });

  it('reports parse errors for invalid JSON', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels, modelAvailability: 'remote' },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    await textarea.setValue('{ invalid json }');
    await nextTick();

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Parse error');
    });
  });

  it('emits import event when button is clicked', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels, modelAvailability: 'remote' },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    const recipe = {
      type: 'chat_group_recipe',
      name: 'Test Recipe',
      models: [],
    };

    await textarea.setValue(JSON.stringify(recipe));
    await nextTick();

    const importBtn = wrapper.get<HTMLButtonElement>('[data-testid="recipe-import-button"]');
    const selected = wrapper.get('input[type="checkbox"]');
    await selected.setValue(false);
    expect(importBtn.element.disabled).toBe(true);
    await selected.setValue(true);
    expect(importBtn.element.disabled).toBe(false);
    await importBtn.trigger('click');

    expect(wrapper.emitted().import).toBeTruthy();
    const emitted = wrapper.emitted().import as any[][];
    expect(emitted[0]![0]).toEqual([{
      newName: 'Test Recipe',
      matchedModelId: undefined,
      recipe: expect.objectContaining({ name: 'Test Recipe' }),
    }]);

    // Should clear input after import
    expect((textarea.element as HTMLTextAreaElement).value).toBe('');
  });

  it('allows renaming before import', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels, modelAvailability: 'remote' },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    await textarea.setValue(JSON.stringify({
      type: 'chat_group_recipe',
      name: 'Original',
      models: [],
    }));
    await nextTick();

    const nameInput = wrapper.get('[data-testid="recipe-name-input"]');
    await nameInput.setValue('New Name');

    const importBtn = wrapper.find('[data-testid="recipe-import-button"]');
    await importBtn.trigger('click');

    const emitted = wrapper.emitted().import as any[][];
    expect(emitted[0]![0][0].newName).toBe('New Name');
  });

  it('puts the matched model first and lets the recipe use the default or a different model', async () => {
    const wrapper = mount(RecipeImportTab, {
      attachTo: document.body,
      props: { availableModels: ['model-3', 'model-1', 'model-2'], modelAvailability: 'remote' },
    });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="recipe-json-input"]').setValue(JSON.stringify({
      type: 'chat_group_recipe',
      name: 'Test Recipe',
      models: [{ type: 'regex', pattern: '^model-2$', flags: [] }],
    }));

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    const popup = new DOMWrapper(document.body);
    expect(popup.findAll('[data-testid="model-selector-option"]').map(option => option.attributes('title'))).toEqual(['model-2', 'model-1', 'model-3']);
    expect(popup.find('[data-testid="model-selector-refresh"]').exists()).toBe(false);
    await popup.get('[data-testid="model-selector-clear"]').trigger('click');
    expect(trigger.text()).toBe('Use Default Model');

    await trigger.trigger('click');
    expect(popup.findAll('[data-testid="model-selector-option"]').map(option => option.attributes('title'))).toEqual(['model-1', 'model-2', 'model-3']);
    await popup.get('[data-testid="model-selector-option"][title="model-3"]').trigger('click');
    await wrapper.get('[data-testid="recipe-import-button"]').trigger('click');

    expect(wrapper.emitted('import')).toEqual([[[{
      newName: 'Test Recipe',
      matchedModelId: 'model-3',
      recipe: expect.objectContaining({ name: 'Test Recipe' }),
    }]]]);
  });
});
