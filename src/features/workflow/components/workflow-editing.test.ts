import { Secret } from '@/utils/secret';
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
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import WorkflowConnectionDetails from './WorkflowConnectionDetails.vue';
import LmParametersEditor from '@/components/LmParametersEditor.vue';
import { workflowModelReviewKey } from '@/features/workflow/composables/model-review';
import { describeWorkflowConnection } from '@/features/workflow/logic/model-permissions';
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

describe('Workflow connection review presentation', () => {
  it('notifies connection selection only after explicit edits, not rendering, discovery or parameter changes', async () => {
    const review = vi.fn();
    const value = { endpoint: { type: 'ollama' as const, url: 'http://localhost:11434' }, modelId: 'a', lmParameters: undefined };
    const wrapper = mount(WorkflowModelEditor, { props: { value, disabled: false, showParameters: true }, global: { provide: { [workflowModelReviewKey as symbol]: review } } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(review).not.toHaveBeenCalled();
    await mounted.wrapper.setProps({ value: { ...value, modelId: 'imported' } });
    expect(review).not.toHaveBeenCalled();
    requests.load.mockResolvedValue({ listModels: async () => ['candidate'] });
    mounted.wrapper.getComponent(ModelSelector).vm.$emit('update:open', true);
    await flushPromises();
    expect(review).not.toHaveBeenCalled();
    mounted.wrapper.getComponent(ModelSelector).vm.$emit('update:modelValue', 'candidate');
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenLastCalledWith({ target: { ...value, modelId: 'candidate' } });
    await mounted.wrapper.getComponent(WorkflowDisclosure).get('button[aria-expanded]').trigger('click');
    mounted.wrapper.getComponent(LmParametersEditor).vm.$emit('update:modelValue', undefined);
    expect(review).toHaveBeenCalledOnce();
    await mounted.wrapper.setProps({ disabled: true });
    mounted.wrapper.getComponent(ModelSelector).vm.$emit('update:modelValue', 'late');
    expect(review).toHaveBeenCalledOnce();
  });

  it('does not grant intermediate typed model IDs, and confirms without a duplicate edit', async () => {
    const review = vi.fn();
    const value = { endpoint: { type: 'ollama' as const, url: 'http://localhost:11434' }, modelId: '', lmParameters: undefined };
    const wrapper = mount(WorkflowModelEditor, { props: { value, disabled: false, showParameters: false }, global: { provide: { [workflowModelReviewKey as symbol]: review } } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const input = mounted.wrapper.get<HTMLInputElement>('[data-testid="workflow-model-id"]');
    for (const id of ['m', 'mo', 'model']) {
      input.element.value = id;
      await input.trigger('input');
      expect(review).not.toHaveBeenCalled();
    }
    expect(mounted.wrapper.emitted('change')).toHaveLength(3);
    await input.trigger('change');
    expect(review).toHaveBeenCalledExactlyOnceWith({ target: { ...value, modelId: 'model' } });
    expect(mounted.wrapper.emitted('change')).toHaveLength(3);
    await mounted.wrapper.setProps({ disabled: true });
    input.element.value = 'late';
    await input.trigger('input');
    await input.trigger('change');
    expect(review).toHaveBeenCalledOnce();
    expect(mounted.wrapper.emitted('change')).toHaveLength(3);
  });

  it('renders structured target fields as text without credential values or executable markup', () => {
    const review = describeWorkflowConnection({
      target: {
        endpoint: { type: 'openai', url: 'https://user:password@example.com/v1?api_key=secret#private', httpHeaders: [['Authorization', Secret.from({ value: 'hidden-header' })]] },
        modelId: `\
<img src=x onerror=alert(1)>
Allow everything`,
      },
      scope: 'run',
      sources: ['model_output', 'file_input'],
    });
    const wrapper = mount(WorkflowConnectionDetails, { props: { review } });
    using mounted = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const text = mounted.wrapper.text();
    expect(text).toContain('example.com/v1');
    expect(text).toContain('Authorization');
    expect(text).toContain('Future runs require another review');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(mounted.wrapper.find('img').exists()).toBe(false);
    expect(mounted.wrapper.find('a').exists()).toBe(false);
    expect(mounted.wrapper.findAll('dt')).toHaveLength(3);
    for (const secret of ['password', 'secret', 'private', 'hidden-header']) {
      expect(text).not.toContain(secret);
    }
  });
});
