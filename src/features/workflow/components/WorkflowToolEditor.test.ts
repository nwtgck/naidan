import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toVolumeId } from '@/01-models/ids';
import type { WorkflowStep } from '@/01-models/workflow';
import { toolStep, toolRequest } from '@/features/workflow/logic/tool.test-support';
import { analyzeWorkflowTypes, emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import WorkflowToolEditor from './WorkflowToolEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';

vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}), availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function editor({ step }: { step: Extract<WorkflowStep, { type: 'tool_call' }> }) {
  const drafts = createWorkflowInputDrafts();
  const scope = ref(analyzeWorkflowTypes({ definition: { name: '', steps: [step] } }).inputs.get(step.id) ?? emptyWorkflowTypeScope());
  const wrapper = mount(WorkflowToolEditor, {
    props: { step, steps: [step], volumes: [{ id: toVolumeId({ raw: 'folder' }), name: 'Documents', type: 'host', createdAt: 1 }], disabled: false },
    global: { provide: { [workflowInputDraftsKey as symbol]: drafts, [workflowValueScopeKey as symbol]: scope } },
  });
  return {
    wrapper,
    drafts,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('renders imported literal arguments as normal fields without silently rewriting the definition', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  using view = editor({ step });
  await flushPromises();
  expect(view.wrapper.get('[data-tool-field="expression"]').getComponent(WorkflowValueEditor).props('value')).toEqual({ type: 'literal', value: '1 + 1' });
  expect(view.wrapper.emitted('change')).toBeUndefined();
});

it('switches capability explicitly and defaults the shell to an unselected read-only folder', async () => {
  using view = editor({ step: toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' }) });
  view.wrapper.findAllComponents({ name: 'SettingsFormSelect' })[0]!.vm.$emit('update:modelValue', 'shell_execute');
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ tool: { name: 'shell_execute', volumeId: '', access: 'read-only' }, arguments: { type: 'object', properties: { shell_script: { value: 'ls' } } } });
});

it('preserves other imported fields when a typed argument is edited', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'shell_execute' }), onError: 'continue' });
  using view = editor({ step });
  view.wrapper.get('[data-tool-field="shell_script"]').getComponent(WorkflowValueEditor).vm.$emit('change', { type: 'literal', value: 'cat note.txt' });
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ onError: 'continue', arguments: { properties: { shell_script: { value: 'cat note.txt' }, timeout_ms: { value: 8000 }, stdout_limit: { value: 16384 } } } });
});

it('locks structural actions during an incomplete numeric draft while allowing the owner to finish', async () => {
  using view = editor({ step: toolStep({ id: 'call', request: toolRequest({ name: 'shell_execute' }), onError: 'fail' }) });
  const field = view.wrapper.get('[data-tool-field="timeout_ms"] input[inputmode="decimal"]');
  await field.setValue('-');
  expect(view.drafts.dirty.value).toBe(true);
  const selectors = view.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).filter(select => ['shell_execute', 'folder', 'read-only', 'fail'].includes(String(select.props('modelValue'))));
  for (const select of selectors) {
    expect(select.props('disabled')).toBe(true);
  }
  selectors[0]!.vm.$emit('update:modelValue', 'calculator');
  selectors[1]!.vm.$emit('update:modelValue', 'other');
  selectors[2]!.vm.$emit('update:modelValue', 'read-write');
  selectors[3]!.vm.$emit('update:modelValue', 'continue');
  expect(view.wrapper.emitted('change')).toBeUndefined();
  await field.setValue('2500');
  expect(view.drafts.dirty.value).toBe(false);
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ arguments: { properties: { timeout_ms: { value: 2500 } } } });
});

it('does not display a plausible Wikipedia query for an absent required argument', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'wikipedia_search' }), onError: 'fail' });
  step.arguments = { type: 'literal', value: {} };
  using view = editor({ step });
  expect(view.wrapper.get('[data-tool-field="lang"]').getComponent(WorkflowValueEditor).props('value')).toEqual({ type: 'literal', value: '' });
  expect(view.wrapper.emitted('change')).toBeUndefined();
});

it('preserves an expression for the complete argument object', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  step.arguments = { type: 'step_output', stepId: step.id, output: 'metadata' };
  using view = editor({ step });
  expect(view.wrapper.find('[data-tool-field]').exists()).toBe(false);
  expect(view.wrapper.getComponent(WorkflowValueEditor).props('value')).toEqual(step.arguments);
  expect(view.wrapper.emitted('change')).toBeUndefined();
});

it('ignores stale selection and value callbacks after the editor is disabled', async () => {
  using view = editor({ step: toolStep({ id: 'call', request: toolRequest({ name: 'shell_execute' }), onError: 'fail' }) });
  await view.wrapper.setProps({ disabled: true });
  const selectors = view.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).filter(select => ['shell_execute', 'folder', 'read-only', 'fail'].includes(String(select.props('modelValue'))));
  selectors[0]!.vm.$emit('update:modelValue', 'calculator');
  selectors[1]!.vm.$emit('update:modelValue', 'other');
  selectors[2]!.vm.$emit('update:modelValue', 'read-write');
  selectors[3]!.vm.$emit('update:modelValue', 'continue');
  view.wrapper.get('[data-tool-field="shell_script"]').getComponent(WorkflowValueEditor).vm.$emit('change', { type: 'literal', value: 'ls' });
  expect(view.wrapper.emitted('change')).toBeUndefined();
});

export const TEST_ONLY = {
};
