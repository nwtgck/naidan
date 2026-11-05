import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { audioStep } from '@/features/workflow/logic/audio-generation.test-support';
import { valueStep, literal } from '@/features/workflow/logic/workflow.test-support';
import { analyzeWorkflowTypes, emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { workflowAudioModelReviewKey } from '@/features/workflow/composables/model-review';
import { workflowInputDraftsKey, createWorkflowInputDrafts } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import WorkflowAudioEditor from './WorkflowAudioEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import type { WorkflowStep } from '@/01-models/workflow';

const mocks = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn() }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: { listModelEntries: mocks.list } }));
vi.mock('@/features/audio-generation/model-detection', async importOriginal => ({ ...await importOriginal<typeof import('@/features/audio-generation/model-detection')>(), inspectStoredAudioModel: mocks.inspect }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}), availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.list.mockReset();
  mocks.inspect.mockReset();
  mocks.list.mockResolvedValue([{ modelId: 'voice.gguf', size: 200 }, { modelId: 'text.gguf', size: 100 }]);
  mocks.inspect.mockImplementation(async ({ modelId }: { modelId: string }) => modelId === 'voice.gguf' ? { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' } : { status: 'unverified', reason: 'architecture' });
});

function editor({ step, before }: { step: Extract<WorkflowStep, { type: 'audio_generation' }>, before: WorkflowStep[] }) {
  const review = vi.fn();
  const drafts = createWorkflowInputDrafts();
  const steps = [...before, step];
  const scope = ref(analyzeWorkflowTypes({ definition: { name: '', steps } }).inputs.get(step.id) ?? emptyWorkflowTypeScope());
  const wrapper = mount(WorkflowAudioEditor, {
    props: { step, steps, disabled: false },
    global: {
      provide: {
        [workflowAudioModelReviewKey as symbol]: review,
        [workflowInputDraftsKey as symbol]: drafts,
        [workflowValueScopeKey as symbol]: scope,
      },
    },
  });
  return {
    wrapper,
    review,
    drafts,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Workflow audio editor', () => {
  it('does not discover, select or authorize a model just by rendering an imported step', async () => {
    using view = editor({ step: audioStep({ id: 'voice' }), before: [] });
    await flushPromises();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(view.review).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('change')).toBeUndefined();
  });

  it('discovers local candidates explicitly without applying the detector default', async () => {
    const step = { ...audioStep({ id: 'voice' }), modelId: literal({ value: 'keep-this.gguf' }) };
    using view = editor({ step, before: [] });
    view.wrapper.getComponent(ModelSelector).vm.$emit('update:open', true);
    await flushPromises();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(view.wrapper.getComponent(ModelSelector).props('models')).toEqual(['voice.gguf']);
    expect(view.wrapper.getComponent(ModelSelector).props('modelValue')).toBe('keep-this.gguf');
    expect(view.review).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('change')).toBeUndefined();
  });

  it('approves only a selected or committed model, not intermediate keystrokes', async () => {
    using view = editor({ step: audioStep({ id: 'voice' }), before: [] });
    const input = view.wrapper.get('[data-testid="workflow-audio-model-id"]');
    (input.element as HTMLInputElement).value = 'm';
    await input.trigger('input');
    expect(view.review).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ modelId: literal({ value: 'm' }) });
    (input.element as HTMLInputElement).value = 'model.gguf';
    await input.trigger('input');
    await input.trigger('change');
    expect(view.review).toHaveBeenCalledExactlyOnceWith({ modelId: 'model.gguf' });
    view.wrapper.getComponent(ModelSelector).vm.$emit('update:modelValue', 'other.gguf');
    expect(view.review).toHaveBeenLastCalledWith({ modelId: 'other.gguf' });
  });

  it('does not authorize model-name expressions through the plain selection callback', async () => {
    using view = editor({ step: audioStep({ id: 'voice' }), before: [] });
    await view.wrapper.get('[data-testid="workflow-audio-model-value"]').trigger('click');
    const valueEditor = view.wrapper.findAllComponents(WorkflowValueEditor)[0]!;
    valueEditor.vm.$emit('change', literal({ value: 'from-expression.gguf' }));
    expect(view.review).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ modelId: literal({ value: 'from-expression.gguf' }) });
  });

  it('ignores late candidate discovery after the editor is locked', async () => {
    using view = editor({ step: audioStep({ id: 'voice' }), before: [] });
    const gate = Promise.withResolvers<unknown[]>();
    mocks.list.mockReturnValue(gate.promise);
    view.wrapper.getComponent(ModelSelector).vm.$emit('update:open', true);
    await flushPromises();
    await view.wrapper.setProps({ disabled: true });
    gate.resolve([{ modelId: 'late', size: 2 }]);
    await flushPromises();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(view.wrapper.getComponent(ModelSelector).props('models')).toEqual([]);
    expect(view.review).not.toHaveBeenCalled();
  });

  it('uses typed binary references instead of accepting a URL for the reference voice', async () => {
    const first = audioStep({ id: 'first' });
    const step = audioStep({ id: 'second' });
    using view = editor({ step, before: [first, valueStep({ id: 'text', value: literal({ value: 'not a voice' }) })] });
    await view.wrapper.get('[data-testid="workflow-audio-reference-enabled"]').setValue(true);
    expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ reference: { type: 'step_output', stepId: first.id, output: 'audio' } });
  });

  it('protects incomplete numeric drafts and lets their owner finish editing', async () => {
    using view = editor({ step: audioStep({ id: 'voice' }), before: [] });
    await view.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
    const field = view.wrapper.get('[data-audio-parameter="maxFrames"] input[inputmode="decimal"]');
    await field.setValue('-');
    expect(view.drafts.dirty.value).toBe(true);
    expect(view.wrapper.get('[data-testid="workflow-audio-model-id"]').attributes('disabled')).toBeDefined();
    expect(view.wrapper.emitted('change')).toBeUndefined();
    await field.setValue('12');
    expect(view.drafts.dirty.value).toBe(false);
    expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ parameters: { maxFrames: literal({ value: 12 }) } });
  });
});
