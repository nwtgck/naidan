import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RecipeImportTab from './RecipeImportTab.vue';

describe('RecipeImportTab.vue', () => {
  const mockModels = ['llama3', 'gpt-4'];

  it('renders correctly with empty state', () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels },
    });
    expect(wrapper.find('[data-testid="recipe-json-input"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Recipes');
  });

  it('automatically analyzes JSON input and displays recipe list', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    const recipe = {
      type: 'chat_group_recipe',
      name: 'Test Recipe',
      models: [{ type: 'regex', pattern: 'llama3', flags: ['i'] }]
    };

    await textarea.setValue(JSON.stringify(recipe));
    await nextTick();

    expect(wrapper.text()).toContain('Detected Recipes (1)');
    expect((wrapper.find('input[placeholder="Chat Group Name"]').element as HTMLInputElement).value).toBe('Test Recipe');
    expect(wrapper.text()).toContain('llama3');
  });

  it('reports parse errors for invalid JSON', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    await textarea.setValue('{ invalid json }');
    await nextTick();

    expect(wrapper.text()).toContain('Parse error');
  });

  it('emits import event when button is clicked', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    const recipe = {
      type: 'chat_group_recipe',
      name: 'Test Recipe',
      models: []
    };

    await textarea.setValue(JSON.stringify(recipe));
    await nextTick();

    const importBtn = wrapper.find('[data-testid="recipe-import-button"]');
    await importBtn.trigger('click');

    expect(wrapper.emitted().import).toBeTruthy();
    const emitted = wrapper.emitted().import as any[][];
    expect(emitted[0]![0]).toEqual([{
      newName: 'Test Recipe',
      matchedModelId: undefined,
      recipe: expect.objectContaining({ name: 'Test Recipe' })
    }]);

    // Should clear input after import
    expect((textarea.element as HTMLTextAreaElement).value).toBe('');
  });

  it('allows renaming before import', async () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: mockModels },
    });
    const textarea = wrapper.find('[data-testid="recipe-json-input"]');

    await textarea.setValue(JSON.stringify({
      type: 'chat_group_recipe',
      name: 'Original',
      models: []
    }));
    await nextTick();

    const nameInput = wrapper.find('input.text-base.font-bold');
    await nameInput.setValue('New Name');

    const importBtn = wrapper.find('[data-testid="recipe-import-button"]');
    await importBtn.trigger('click');

    const emitted = wrapper.emitted().import as any[][];
    expect(emitted[0]![0][0].newName).toBe('New Name');
  });

  it('sorts matched model to the top of the list', () => {
    const wrapper = mount(RecipeImportTab, {
      props: { availableModels: ['model-1', 'model-2', 'model-3'] },
    });
    const vm = wrapper.vm as any;

    // Test sorting with a matched model
    const sorted = vm.getSortedModels('model-2');
    expect(sorted[0]).toBe('model-2');
    expect(sorted).toHaveLength(3);
    expect(sorted).toContain('model-1');
    expect(sorted).toContain('model-3');

    // Test sorting with no match
    const original = vm.getSortedModels(undefined);
    expect(original).toEqual(['model-1', 'model-2', 'model-3']);
  });
});