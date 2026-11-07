import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { WorkflowExecutionLimits, WorkflowValue } from '@/01-models/workflow';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import SettingsSelect from '@/components/SettingsSelect.vue';
import WorkflowExecutionSettings from './WorkflowExecutionSettings.vue';
import WorkflowStepEditor from './WorkflowStepEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { DEFAULT_WORKFLOW_EXECUTION_LIMITS } from '@/features/workflow/logic/execution-control';
import { baseStep, valueStep, literal, reference } from '@/features/workflow/logic/workflow.test-support';

vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({ experimental: undefined }), availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function settings({ value, running }: { value: WorkflowExecutionLimits | undefined, running: boolean }) {
  const drafts = createWorkflowInputDrafts();
  const wrapper = mount(WorkflowExecutionSettings, { props: { value, disabled: false, running }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
  return {
    wrapper,
    drafts,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Editable execution-wide limits', () => {
  it('shows effective defaults and materializes the complete local configuration only when edited', async () => {
    using view = settings({ value: undefined, running: false });
    expect(view.wrapper.emitted('change')).toBeUndefined();
    await view.wrapper.get('button[aria-expanded]').trigger('click');
    const loop = view.wrapper.get('input[aria-label="Total loop iterations"]');
    expect((loop.element as HTMLInputElement).value).toBe('10000');
    await loop.setValue('20000');
    expect(view.wrapper.emitted('change')?.at(-1)).toEqual([{ ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, maxLoopIterations: 20000 }]);
    expect(view.wrapper.find('select').exists()).toBe(false);
  });

  it('preserves an incomplete input and disables resets and neighboring controls', async () => {
    using view = settings({ value: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS }, running: false });
    await view.wrapper.get('button[aria-expanded]').trigger('click');
    const loop = view.wrapper.get('input[aria-label="Total loop iterations"]');
    await loop.setValue('-');
    expect(view.drafts.dirty.value).toBe(true);
    expect(view.wrapper.emitted('change')).toBeUndefined();
    const reset = view.wrapper.findAll('button').find(button => button.text() === 'Use default limits')!;
    expect(reset.attributes('disabled')).toBeDefined();
    expect(view.wrapper.get('input[aria-label="Time limit"]').attributes('disabled')).toBeDefined();
    expect(view.wrapper.get('input[aria-label="Step executions"]').attributes('disabled')).toBeDefined();
    expect(loop.attributes('disabled')).toBeUndefined();
    await loop.setValue('100');
    expect(view.drafts.dirty.value).toBe(false);
    expect(reset.attributes('disabled')).toBeUndefined();
    await reset.trigger('click');
    expect(view.wrapper.emitted('change')?.at(-1)).toEqual([undefined]);
  });

  it('keeps time units explicit and warns that edits do not change a running snapshot', async () => {
    using view = settings({ value: undefined, running: true });
    await view.wrapper.get('button[aria-expanded]').trigger('click');
    expect(view.wrapper.text()).toContain('next run');
    await view.wrapper.get('input[aria-label="Time limit"]').setValue(true);
    expect(view.wrapper.emitted('change')?.at(-1)).toEqual([{ ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, timeoutMs: 300000 }]);
    await view.wrapper.setProps({ value: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, timeoutMs: 300000 } });
    await view.wrapper.get('input[aria-label="Time limit (seconds)"]').setValue('0.5');
    expect(view.wrapper.emitted('change')?.at(-1)).toEqual([{ ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, timeoutMs: 500 }]);
    await view.wrapper.setProps({ value: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, maxLoopIterations: -1 } });
    expect(view.wrapper.get('[role="alert"]').text()).toContain('nonnegative');
  });
});

describe('Type-guided loop exit and value composition', () => {
  it('offers boolean expressions and current body outputs for an exit condition, not a raw ID field', async () => {
    const step = baseStep({ type: 'for_each', id: 'loop' });
    if (step.type !== 'for_each') {
      throw new Error('fixture');
    }
    step.body.steps = [valueStep({ id: 'decision', value: literal({ value: true }) })];
    const wrapper = mount(WorkflowStepEditor, { props: { step, steps: [step, ...step.body.steps], definition: { name: '', steps: [step] }, disabled: false, volumes: [] } });
    using owner = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    void owner;
    await wrapper.get('input[aria-label="Stop after this iteration when"]').setValue(true);
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ stopWhen: { type: 'literal', value: false } });
    await wrapper.setProps({ step: { ...step, stopWhen: reference({ id: 'decision', output: 'value' }) } });
    const condition = wrapper.findAllComponents(WorkflowValueEditor).find(editor => editor.props('expected') === 'boolean')!;
    expect(condition).toBeDefined();
    const options = condition.findAllComponents(SettingsSelect).flatMap(select => select.props('options'));
    expect(options.some(option => option.label?.includes('decision'))).toBe(true);
    expect(options.some(option => option.value === 'compare')).toBe(true);
    expect(options.some(option => option.value === 'text')).toBe(false);
    expect(condition.props('scope')?.outputs.has(step.body.steps[0]!.id)).toBe(true);
  });

  it('edits numeric operators with numeric operands, without an expression language', async () => {
    const value: WorkflowValue = { type: 'arithmetic', operator: 'add', left: literal({ value: 1 }), right: literal({ value: 2 }) };
    const wrapper = mount(WorkflowValueEditor, { props: { value, steps: [], disabled: false, expected: 'number' } });
    using owner = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    void owner;
    const operation = wrapper.findAllComponents(SettingsSelect).find(select => select.props('options').some(option => option.value === 'multiply'))!;
    expect(operation).toBeDefined();
    operation.vm.$emit('update:modelValue', 'multiply');
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('change')?.at(-1)).toEqual([{ ...value, operator: 'multiply' }]);
    const children = wrapper.findAllComponents(WorkflowValueEditor);
    expect(children.every(editor => editor.props('expected') === 'number')).toBe(true);
    expect(wrapper.find('textarea').exists()).toBe(false);
  });
});
