import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowJsonComposer from './WorkflowJsonComposer.vue';
import WorkflowModelEditor from './WorkflowModelEditor.vue';
import WorkflowStepEditor from './WorkflowStepEditor.vue';
import WorkflowStepList from './WorkflowStepList.vue';
import SettingsSelect from '@/components/SettingsSelect.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import type { WorkflowValue } from '@/01-models/workflow';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { baseStep, valueStep, literal, reference } from '@/features/workflow/logic/workflow.test-support';
const requests = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: requests.load }));
const settings = ref({ experimental: undefined });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  requests.load.mockReset();
});

function editor({ value, expected }: { value: WorkflowValue, expected?: 'iterable' }) {
  const drafts = createWorkflowInputDrafts();
  const wrapper = mount(WorkflowValueEditor, { props: { value, steps: [], disabled: false, expected }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
  return {
    wrapper,
    drafts,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Discoverable Workflow editing', () => {
  it('uses the Settings selector and filters iterable inputs without hiding an invalid current value', () => {
    using view = editor({ value: { type: 'array', items: [] }, expected: 'iterable' });
    const selector = view.wrapper.getComponent(SettingsSelect);
    expect(selector.props('options').some(option => option.value === 'text')).toBe(false);
    expect(selector.props('options').some(option => option.value === 'range')).toBe(true);
    expect(view.wrapper.find('select').exists()).toBe(false);
  });

  it('shows and edits literal JSON directly, and retains invalid drafts', async () => {
    using view = editor({ value: { type: 'literal', value: { temperature: 0.7 } } });
    const input = view.wrapper.get('[data-testid="workflow-json-content"]');
    expect((input.element as HTMLTextAreaElement).value).toContain('temperature');
    await input.setValue('{');
    expect(view.drafts.dirty.value).toBe(true);
    expect(view.wrapper.emitted('change')).toBeUndefined();
    await input.setValue('{"temperature":0.5}');
    expect(view.drafts.dirty.value).toBe(false);
    expect(view.wrapper.emitted('change')?.at(-1)).toEqual([{ type: 'literal', value: { temperature: 0.5 } }]);
  });

  it('protects partially typed numeric values instead of converting empty input to zero', async () => {
    using view = editor({ value: { type: 'literal', value: 12 } });
    await view.wrapper.get('input[inputmode="decimal"]').setValue('-');
    expect(view.drafts.dirty.value).toBe(true);
    expect(view.wrapper.emitted('change')).toBeUndefined();
    await view.wrapper.get('input[inputmode="decimal"]').setValue('-2');
    expect(view.wrapper.emitted('change')).toEqual([[{ type: 'literal', value: -2 }]]);
  });

  it('renders a dynamic JSON value at its field and preserves other literal content', async () => {
    const loop = baseStep({ type: 'for_each', id: 'models' });
    const scope = emptyWorkflowTypeScope();
    scope.loops.set(loop.id, { step: loop, item: { kind: 'text' }, state: {} });
    const value: Extract<WorkflowValue, { type: 'json_compose' }> = { type: 'json_compose', base: { endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: '' }, assignments: [{ path: ['modelId'], value: { type: 'loop_item', stepId: loop.id } }] };
    const wrapper = mount(WorkflowJsonComposer, { props: { value, scope, steps: [loop], disabled: false } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(mounted.wrapper.text()).toContain('"modelId":');
    expect(mounted.wrapper.get('[data-testid="workflow-inline-reference"]').text()).toContain('models');
    expect(mounted.wrapper.text()).toContain('http://localhost');
    await mounted.wrapper.get('[data-testid="workflow-inline-reference"]').trigger('click');
    expect(mounted.wrapper.findAllComponents(WorkflowValueEditor)).toHaveLength(1);
  });

  it('rejects a raw array reorder that would retarget an inline reference', async () => {
    const drafts = createWorkflowInputDrafts();
    const value: Extract<WorkflowValue, { type: 'json_compose' }> = { type: 'json_compose', base: { list: ['first', 'second'] }, assignments: [{ path: ['list', 1], value: literal({ value: 'bound' }) }] };
    const wrapper = mount(WorkflowJsonComposer, { props: { value, scope: emptyWorkflowTypeScope(), steps: [], disabled: false }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="workflow-json-content"]').setValue('{"list":["second","first"]}');
    expect(mounted.wrapper.emitted('change')).toBeUndefined();
    expect(drafts.dirty.value).toBe(true);
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain('ambiguous');
  });

  it('offers only fields known on the selected object without forcing a JSON path editor', () => {
    using view = editor({ value: { type: 'get', value: { type: 'literal', value: { title: 'Title', prompt: 'Prompt' } }, path: [] } });
    const choices = view.wrapper.findAllComponents(SettingsSelect).flatMap(item => item.props('options'));
    expect(choices.some(option => option.value === 'title')).toBe(true);
    expect(choices.some(option => option.value === 'prompt')).toBe(true);
  });

  it('provides lexical scope to nested step fields, not every flattened step in the workflow', () => {
    const preceding = valueStep({ id: 'before', value: { type: 'literal', value: ['a'] } });
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    const child = baseStep({ type: 'text_generation', id: 'child' });
    if (loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    loop.source = reference({ id: 'before', output: 'value' });
    loop.body.steps = [child];
    const definition = { name: '', steps: [preceding, loop] };
    const wrapper = mount(WorkflowStepEditor, { props: { step: loop, steps: [preceding, loop, child], definition, volumes: [], disabled: false } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const value = mounted.wrapper.findAllComponents(WorkflowValueEditor)[0]!;
    expect(value.props('expected')).toBe('iterable');
    const options = value.findAllComponents(SettingsSelect).flatMap(select => select.props('options'));
    expect(options.some(option => option.label?.includes('before'))).toBe(true);
    expect(options.some(option => option.label?.includes('child'))).toBe(false);
  });

  it('labels the insertion operation explicitly before choosing a step type', async () => {
    const wrapper = mount(WorkflowStepList, { props: { steps: [], selected: new Set<import('@/01-models/ids').WorkflowStepId>(), parentId: undefined, branch: 'root', disabled: false } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const add = mounted.wrapper.findAll('button').find(button => button.text().includes('Add step'))!;
    expect(add).toBeDefined();
    await add.trigger('click');
    mounted.wrapper.getComponent(SettingsSelect).vm.$emit('update:modelValue', 'model_selection');
    expect(mounted.wrapper.emitted('add')).toEqual([[{ type: 'model_selection', target: { parentId: undefined, branch: 'root', index: 0 } }]]);
  });
});

describe('Existing model selector integration', () => {
  it('only loads candidates after an explicit open, and still allows direct IDs', async () => {
    const listModels = vi.fn(async () => ['model-10', 'model-2', 'model-2']);
    requests.load.mockResolvedValue({ listModels });
    const wrapper = mount(WorkflowModelEditor, { props: { value: { endpoint: { type: 'llama_cpp_browser' }, modelId: '', lmParameters: undefined }, disabled: false, showParameters: true } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(requests.load).not.toHaveBeenCalled();
    mounted.wrapper.getComponent(ModelSelector).vm.$emit('update:open', true);
    await flushPromises();
    expect(listModels).toHaveBeenCalledOnce();
    expect(mounted.wrapper.getComponent(ModelSelector).props('models')).toEqual(['model-2', 'model-10']);
    await mounted.wrapper.get('[data-testid="workflow-model-id"]').setValue('manual-model');
    expect(mounted.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ modelId: 'manual-model' });
  });

  it('ignores a candidate response from a connection replaced while discovery was pending', async () => {
    const old = Promise.withResolvers<string[]>();
    const listModels = vi.fn(() => old.promise);
    requests.load.mockResolvedValue({ listModels });
    const wrapper = mount(WorkflowModelEditor, { props: { value: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'a', lmParameters: undefined }, disabled: false, showParameters: false } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    mounted.wrapper.getComponent(ModelSelector).vm.$emit('update:open', true);
    await flushPromises();
    await mounted.wrapper.setProps({ value: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'b', lmParameters: undefined } });
    old.resolve(['stale']);
    await flushPromises();
    expect(mounted.wrapper.getComponent(ModelSelector).props('models')).toEqual([]);
    expect(mounted.wrapper.emitted('change')).toBeUndefined();
  });
});
