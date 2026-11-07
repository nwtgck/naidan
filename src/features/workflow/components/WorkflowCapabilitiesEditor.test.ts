import { beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import { emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { baseStep, stepId } from '@/features/workflow/logic/workflow.test-support';
import { imageStep } from '@/features/workflow/logic/image-generation.test-support';
import type { WorkflowStep } from '@/01-models/workflow';
import WorkflowGenerationToolsEditor from './WorkflowGenerationToolsEditor.vue';
import WorkflowImageInputsEditor from './WorkflowImageInputsEditor.vue';
import WorkflowImagePreviewSettings from './WorkflowImagePreviewSettings.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowNumberInput from './WorkflowNumberInput.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({ experimental: undefined }), availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function toolEditor() {
  const step = baseStep({ type: 'text_generation', id: 'text' });
  if (step.type !== 'text_generation') {
    throw new Error('fixture');
  }
  const drafts = createWorkflowInputDrafts();
  const wrapper = mount(WorkflowGenerationToolsEditor, { props: { step, volumes: [], disabled: false }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
  return { wrapper, drafts, step, [Symbol.dispose]: () => wrapper.unmount() };
}

it('does not enable tools merely by rendering and makes shell access explicit and read-only', async () => {
  using test = toolEditor();
  expect(test.wrapper.emitted('change')).toBeUndefined();
  await test.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
  await test.wrapper.get('[data-tool-key="builtin.wesh"]').setValue(true);
  const changed = test.wrapper.emitted('change')?.at(-1)?.[0];
  expect(changed).toMatchObject({ toolConfigs: [{ key: 'builtin.wesh', status: 'enabled', naidanSysfs: { accessScope: 'none' } }], toolExecution: { maxRounds: 8, maxCalls: 32, shell: { volumeId: '', access: 'read-only' } } });
});

it('preserves imported tool limits, other tools and explicit folder policy when toggling a tool', async () => {
  using test = toolEditor();
  const step: Extract<WorkflowStep, { type: 'text_generation' }> = { ...test.step, toolConfigs: [{ key: 'builtin.wikipedia', status: 'enabled' }], toolExecution: { maxRounds: 3, maxCalls: 7, shell: undefined } };
  await test.wrapper.setProps({ step });
  await test.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
  await test.wrapper.get('[data-tool-key="builtin.calculator"]').setValue(true);
  expect(test.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ toolConfigs: [{ key: 'builtin.wikipedia', status: 'enabled' }, { key: 'builtin.calculator', status: 'enabled' }], toolExecution: { maxRounds: 3, maxCalls: 7 } });
});

it('preserves incomplete numeric limits and rejects structural or late changes while locked', async () => {
  using test = toolEditor();
  await test.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
  const input = test.wrapper.findAllComponents(WorkflowNumberInput)[0]!.get('input');
  await input.setValue('-');
  expect(test.drafts.dirty.value).toBe(true);
  test.wrapper.findAllComponents(WorkflowNumberInput)[1]!.vm.$emit('change', 2);
  expect(test.wrapper.emitted('change')).toBeUndefined();
  await input.setValue('4');
  expect(test.drafts.dirty.value).toBe(false);
  expect(test.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ toolExecution: { maxRounds: 4 } });
  await test.wrapper.setProps({ disabled: true });
  test.wrapper.findAllComponents(WorkflowNumberInput)[1]!.vm.$emit('change', 5);
  expect(test.wrapper.emitted('change')).toHaveLength(1);
});

it('edits initial and reference images as typed binary values without rewriting other settings', async () => {
  const step = imageStep({ id: 'image' });
  step.imageInputs = { initImage: { type: 'step_output', stepId: stepId({ raw: 'read' }), output: 'file' }, referenceImages: [{ type: 'step_output', stepId: stepId({ raw: 'prior' }), output: 'image' }], strength: { type: 'literal', value: 0.6 } };
  const wrapper = mount(WorkflowImageInputsEditor, { props: { step, steps: [], disabled: false }, global: { provide: { [workflowValueScopeKey as symbol]: ref(emptyWorkflowTypeScope()) } } });
  using test = { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
  expect(test.wrapper.emitted('change')).toBeUndefined();
  expect(test.wrapper.findAllComponents(WorkflowValueEditor).map(component => component.props('expected'))).toEqual(['binary', 'number', 'binary']);
  test.wrapper.findAllComponents(WorkflowValueEditor)[2]!.vm.$emit('change', { type: 'literal', value: null });
  expect(test.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ parameters: step.parameters, imageInputs: { initImage: step.imageInputs.initImage, strength: { type: 'literal', value: 0.6 }, referenceImages: [{ type: 'literal', value: null }] } });
});

it('keeps preview settings explicit, accepts automatic edge zero, and ignores late locked selection', async () => {
  const drafts = createWorkflowInputDrafts();
  const wrapper = mount(WorkflowImagePreviewSettings, { props: { value: { enabled: true, interval: 2, startStep: 1, mode: 'projection', maxEdge: 512 }, disabled: false }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
  using test = { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
  const edge = test.wrapper.findAllComponents(WorkflowNumberInput)[2]!.get('input');
  await edge.setValue('-');
  test.wrapper.getComponent({ name: 'SettingsFormSelect' }).vm.$emit('update:modelValue', 'vae');
  expect(test.wrapper.emitted('change')).toBeUndefined();
  await edge.setValue('0');
  expect(test.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ maxEdge: 0, enabled: true });
  await test.wrapper.setProps({ disabled: true });
  test.wrapper.getComponent({ name: 'SettingsFormSelect' }).vm.$emit('update:modelValue', 'vae');
  expect(test.wrapper.emitted('change')).toHaveLength(1);
});

export const TEST_ONLY = {
};
