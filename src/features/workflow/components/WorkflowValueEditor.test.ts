import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import WorkflowValueEditor from './WorkflowValueEditor.vue';

vi.mock('./WorkflowModelEditor.vue', () => ({ default: { template: '<div />' } }));

const wrappers: VueWrapper[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
});

describe('Workflow structured value editor', () => {
  it('keeps invalid JSON in its owning field and blocks destructive sibling edits', async () => {
    const drafts = createWorkflowInputDrafts();
    const options = { props: { value: { type: 'literal' as const, value: 'initial' }, steps: [], disabled: false }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } };
    const first = mount(WorkflowValueEditor, options), sibling = mount(WorkflowValueEditor, options);
    wrappers.push(first, sibling);
    await first.get('[data-testid="workflow-value-json"]').trigger('click');
    await first.get('[data-testid="workflow-value-draft"]').setValue('{');
    await first.get('[data-testid="workflow-value-apply"]').trigger('click');
    expect(first.emitted('change')).toBeUndefined();
    expect(first.get('[role="alert"]').text()).not.toBe('');
    expect((first.get('[data-testid="workflow-value-draft"]').element as HTMLTextAreaElement).value).toBe('{');
    expect(drafts.dirty.value).toBe(true);
    expect(sibling.get('[data-testid="workflow-value-mode"]').attributes('disabled')).toBeDefined();
    expect(first.get('[data-testid="workflow-value-apply"]').attributes('disabled')).toBeUndefined();
    drafts.discardAll();
    await first.vm.$nextTick();
    expect(first.find('[data-testid="workflow-value-draft"]').exists()).toBe(false);
    expect(drafts.dirty.value).toBe(false);
  });

  it('applies structured JSON without interpolating literal template-looking text', async () => {
    const drafts = createWorkflowInputDrafts();
    const wrapper = mount(WorkflowValueEditor, { props: { value: { type: 'literal', value: '' }, steps: [], disabled: false }, global: { provide: { [workflowInputDraftsKey as symbol]: drafts } } });
    wrappers.push(wrapper);
    await wrapper.get('[data-testid="workflow-value-json"]').trigger('click');
    await wrapper.get('[data-testid="workflow-value-draft"]').setValue('{"type":"literal","value":"images/{index}-{title}.png"}');
    await wrapper.get('[data-testid="workflow-value-apply"]').trigger('click');
    expect(wrapper.emitted('change')).toEqual([[{ type: 'literal', value: 'images/{index}-{title}.png' }]]);
    expect(drafts.dirty.value).toBe(false);
  });

  it('keeps the advanced input when its JSON button is pressed again', async () => {
    const wrapper = mount(WorkflowValueEditor, { props: { value: { type: 'literal', value: '' }, steps: [], disabled: false } });
    wrappers.push(wrapper);
    await wrapper.get('[data-testid="workflow-value-json"]').trigger('click');
    await wrapper.get('[data-testid="workflow-value-draft"]').setValue('unfinished');
    await wrapper.get('[data-testid="workflow-value-json"]').trigger('click');
    expect((wrapper.get('[data-testid="workflow-value-draft"]').element as HTMLTextAreaElement).value).toBe('unfinished');
  });
});
