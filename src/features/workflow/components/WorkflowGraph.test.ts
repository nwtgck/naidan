import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { WorkflowDefinition } from '@/01-models/workflow';
import type { WorkflowStepId } from '@/01-models/ids';
import SettingsSelect from '@/components/SettingsSelect.vue';
import WorkflowGraph from './WorkflowGraph.vue';
import WorkflowGraphConnections from './WorkflowGraphConnections.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import { baseStep, valueStep, literal, reference, stepId } from '@/features/workflow/logic/workflow.test-support';
import { workflowGraphScopes, type WorkflowGraphRequest } from '@/features/workflow/logic/graph';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function graph({ definition, selectedId }: { definition: WorkflowDefinition, selectedId: WorkflowStepId | undefined }) {
  const edits = vi.fn<(request: WorkflowGraphRequest) => void>();
  const wrapper = mount(WorkflowGraph, { props: { definition, selectedId, selectedIds: new Set(selectedId === undefined ? [] : [selectedId]), disabled: false, onEdit: edits } });
  return {
    wrapper,
    edits,
    async choose({ testId, value }: { testId: string, value: string }) {
      const select = wrapper.findAllComponents(SettingsSelect).find(component => component.vm.$attrs['data-testid'] === testId);
      if (!select) {
        throw new Error(`Missing select: ${testId}`);
      }
      select.vm.$emit('update:modelValue', value);
      await nextTick();
    },
    options({ testId }: { testId: string }) {
      const select = wrapper.findAllComponents(SettingsSelect).find(component => component.vm.$attrs['data-testid'] === testId);
      if (!select) {
        throw new Error(`Missing select: ${testId}`);
      }
      return select.props('options');
    },
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

const first = valueStep({ id: 'first', value: literal({ value: 'hello' }) });
const second = valueStep({ id: 'second', value: literal({ value: 'old' }) });
const connectionId = JSON.stringify(['output', 'first', 'value']);

describe('Editable Workflow graph', () => {
  it('renders a selected node and inspector bindings without changing the document', () => {
    const definition = { name: 'graph', steps: [first, second] };
    const before = structuredClone(definition);
    using view = graph({ definition, selectedId: second.id });
    expect(view.wrapper.findAll('[data-graph-node]')).toHaveLength(2);
    expect(view.wrapper.get('[data-graph-node="second"] button').attributes('aria-pressed')).toBe('true');
    expect(view.wrapper.getComponent(WorkflowGraphConnections).props('step').id).toBe(second.id);
    expect(view.edits).not.toHaveBeenCalled();
    expect(definition).toEqual(before);
  });

  it('emits selection from a native keyboard-accessible node button', async () => {
    using view = graph({ definition: { name: '', steps: [first, second] }, selectedId: first.id });
    const button = view.wrapper.get('[data-graph-node="second"] [data-testid="graph-select-node"]');
    expect(button.element.tagName).toBe('BUTTON');
    await button.trigger('click');
    expect(view.wrapper.emitted('select')).toEqual([[second.id]]);
  });

  it('shows only compatible preceding sources and requires explicit Apply', async () => {
    const number = valueStep({ id: 'number', value: literal({ value: 3 }) });
    const parse = baseStep({ type: 'parse_json', id: 'parse' });
    using view = graph({ definition: { name: '', steps: [first, number, parse, second] }, selectedId: parse.id });
    await view.choose({ testId: 'graph-input', value: '["source"]' });
    expect(view.options({ testId: 'graph-source' }).map(option => option.value)).toEqual(['', connectionId]);
    await view.choose({ testId: 'graph-source', value: connectionId });
    expect(view.edits).not.toHaveBeenCalled();
    await view.wrapper.get('[data-testid="graph-connect-apply"]').trigger('click');
    expect(view.edits).toHaveBeenCalledOnce();
    expect(view.edits.mock.calls[0]?.[0].edit).toMatchObject({ type: 'connect', stepId: parse.id, location: ['source'], reference: reference({ id: 'first', output: 'value' }) });
  });

  it('warns about unknown types rather than hiding usable dynamic outputs', async () => {
    const parse = baseStep({ type: 'parse_json', id: 'parse' });
    using view = graph({ definition: { name: '', steps: [parse, second] }, selectedId: second.id });
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    // 'any' is always compatible. Select a text consumer to expose the warning.
    const consumer = baseStep({ type: 'parse_json', id: 'consumer' });
    await view.wrapper.setProps({ definition: { name: '', steps: [parse, consumer] }, selectedId: consumer.id });
    await view.choose({ testId: 'graph-input', value: '["source"]' });
    await view.choose({ testId: 'graph-source', value: JSON.stringify(['output', 'parse', 'value']) });
    expect(view.wrapper.get('[data-testid="graph-unknown"]').text()).toContain('dynamic');
  });

  it('clears pending connections on a definition change, even with reused IDs', async () => {
    using view = graph({ definition: { name: '', steps: [first, second] }, selectedId: second.id });
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    await view.choose({ testId: 'graph-source', value: connectionId });
    await view.wrapper.setProps({ definition: { name: 'other', steps: [first, valueStep({ id: 'second', value: literal({ value: 'new document' }) })] } });
    expect(view.wrapper.find('[data-testid="graph-connect-apply"]').exists()).toBe(false);
    expect(view.edits).not.toHaveBeenCalled();
  });

  it('does not emit an unchanged connection or accept fabricated selection events', async () => {
    const connected = valueStep({ id: 'second', value: reference({ id: 'first', output: 'value' }) });
    using view = graph({ definition: { name: '', steps: [first, connected] }, selectedId: connected.id });
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    await view.choose({ testId: 'graph-source', value: connectionId });
    expect(view.wrapper.get('[data-testid="graph-connect-apply"]').attributes('disabled')).toBeDefined();
    await view.choose({ testId: 'graph-source', value: JSON.stringify(['output', 'second', 'value']) });
    expect(view.edits).not.toHaveBeenCalled();
    expect(view.wrapper.get('[data-testid="graph-connect-apply"]').attributes('disabled')).toBeDefined();
  });

  it('gates late source events and connection requests while inline drafts lock navigation', async () => {
    const definition = { name: '', steps: [first, second] };
    using view = graph({ definition, selectedId: second.id });
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    await view.choose({ testId: 'graph-source', value: connectionId });
    await view.wrapper.setProps({ disabled: true });
    await view.choose({ testId: 'graph-source', value: connectionId });
    const connections = view.wrapper.getComponent(WorkflowGraphConnections);
    const request: WorkflowGraphRequest = { definition: connections.props('definition'), edit: { type: 'connect', stepId: second.id, location: ['value'], previous: second.value, reference: reference({ id: 'first', output: 'value' }) } };
    expect(request.definition).toBe(view.wrapper.props('definition'));
    connections.vm.$emit('edit', request);
    await nextTick();
    expect(view.edits).not.toHaveBeenCalled();
    // Positive control: the same request has the current reactive identity. A
    // stale-document guard must not accidentally stand in for the input lock.
    await view.wrapper.setProps({ disabled: false });
    connections.vm.$emit('edit', request);
    await nextTick();
    expect(view.edits).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('opens an empty branch and adds a Step into that branch', async () => {
    const condition = baseStep({ type: 'if', id: 'if' });
    using view = graph({ definition: { name: '', steps: [condition] }, selectedId: undefined });
    await view.wrapper.get('[data-graph-branch="else"]').trigger('click');
    expect(view.wrapper.get('[data-testid="graph-empty"]').text()).toContain('no Steps');
    await view.choose({ testId: 'graph-add-type', value: 'tool_call' });
    await view.wrapper.get('[data-testid="graph-add"]').trigger('click');
    expect(view.wrapper.emitted('add')).toEqual([[{ type: 'tool_call', target: { parentId: condition.id, branch: 'else', index: 0 } }]]);
  });

  it('reveals a selected nested Step and keeps loop indices available there', async () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    loop.body.steps = [second];
    using view = graph({ definition: { name: '', steps: [loop] }, selectedId: second.id });
    expect(view.wrapper.findAll('[data-graph-node]').map(node => node.attributes('data-graph-node'))).toEqual(['second']);
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    expect(view.options({ testId: 'graph-source' }).some(option => option.value === JSON.stringify(['index', 'loop']))).toBe(true);
  });

  it('bounds node rendering and reveals selections on later pages', async () => {
    const steps = Array.from({ length: 85 }, (_, index) => valueStep({ id: String(index), value: literal({ value: index }) }));
    using view = graph({ definition: { name: '', steps }, selectedId: undefined });
    expect(view.wrapper.findAll('[data-graph-node]')).toHaveLength(40);
    expect(view.wrapper.get('[data-testid="graph-page"]').text()).toContain('1 / 3');
    await view.wrapper.get('[data-testid="graph-next"]').trigger('click');
    expect(view.wrapper.findAll('[data-graph-node]')).toHaveLength(40);
    await view.wrapper.setProps({ selectedId: stepId({ raw: '84' }) });
    expect(view.wrapper.findAll('[data-graph-node]')).toHaveLength(5);
    expect(view.wrapper.get('[data-testid="graph-page"]').text()).toContain('3 / 3');
  });

  it('retains external-page reference choices even without visible curves', async () => {
    const steps = Array.from({ length: 41 }, (_, index) => valueStep({ id: String(index), value: index === 40 ? reference({ id: '0', output: 'value' }) : literal({ value: index }) }));
    using view = graph({ definition: { name: '', steps }, selectedId: steps[40]!.id });
    expect(view.wrapper.findAll('[data-testid="graph-reference-curve"]')).toHaveLength(0);
    await view.choose({ testId: 'graph-input', value: '["value"]' });
    expect(view.options({ testId: 'graph-source' }).some(option => option.value === JSON.stringify(['output', '0', 'value']))).toBe(true);
    expect(view.wrapper.get('[data-testid="graph-current"]').text()).toContain('0 · value');
  });

  it('uses one data curve per real reference and not the execution-order line', () => {
    const connected = valueStep({ id: 'second', value: reference({ id: 'first', output: 'value' }) });
    using view = graph({ definition: { name: '', steps: [first, connected] }, selectedId: undefined });
    expect(view.wrapper.findAll('[data-testid="graph-reference-curve"]')).toHaveLength(1);
    expect(view.wrapper.findAll('path[stroke-dasharray]')).toHaveLength(1);
  });

  it('bounds dense reference curves without dropping the underlying inputs', () => {
    const steps = [first, ...Array.from({ length: 10 }, (_, index) => valueStep({ id: `many-${index}`, value: { type: 'array', items: Array.from({ length: 25 }, () => reference({ id: 'first', output: 'value' })) } }))];
    using view = graph({ definition: { name: '', steps }, selectedId: steps[10]!.id });
    expect(view.wrapper.findAll('[data-testid="graph-reference-curve"]')).toHaveLength(200);
    expect(view.wrapper.getComponent(WorkflowGraphConnections).props('bindings')).toHaveLength(26);
  });

  it('uses native move controls and preserves an invalid numeric draft', async () => {
    const definition = { name: '', steps: [first, second] };
    using view = graph({ definition, selectedId: second.id });
    await view.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
    const root = workflowGraphScopes({ definition })[0]!;
    await view.choose({ testId: 'graph-destination', value: root.key });
    await view.wrapper.get('[data-testid="graph-position"]').setValue('-');
    expect((view.wrapper.get('[data-testid="graph-position"]').element as HTMLInputElement).value).toBe('-');
    expect(view.wrapper.get('[data-testid="graph-move-apply"]').attributes('disabled')).toBeDefined();
    await view.wrapper.get('[data-testid="graph-position"]').setValue('1');
    await view.wrapper.get('[data-testid="graph-move-apply"]').trigger('click');
    expect(view.edits.mock.calls[0]?.[0]).toEqual({ definition, edit: { type: 'move', stepId: second.id, target: { parentId: undefined, branch: 'root', index: 0 } } });
  });

  it('rejects an external drop without an in-component drag', async () => {
    using view = graph({ definition: { name: '', steps: [first, second] }, selectedId: undefined });
    await view.wrapper.get('[data-testid="graph-drop-end"]').trigger('drop', { dataTransfer: { getData: () => 'first' } });
    expect(view.edits).not.toHaveBeenCalled();
  });

  it('moves with an internal drag but never trusts the transfer payload', async () => {
    const definition = { name: '', steps: [first, second] };
    using view = graph({ definition, selectedId: undefined });
    await view.wrapper.get('[data-graph-node="second"] [data-testid="graph-drag"]').trigger('dragstart', { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    await view.wrapper.get('[data-graph-node="first"]').trigger('drop', { dataTransfer: { getData: () => 'fabricated' } });
    expect(view.edits.mock.calls[0]?.[0].edit).toEqual({ type: 'move', stepId: second.id, target: { parentId: undefined, branch: 'root', index: 0 } });
    await view.wrapper.get('[data-testid="graph-drop-end"]').trigger('drop');
    expect(view.edits).toHaveBeenCalledOnce();
  });

  it.each(['definition', 'disabled'] as const)('invalidates a drag when %s changes', async kind => {
    const definition = { name: '', steps: [first, second] };
    using view = graph({ definition, selectedId: undefined });
    await view.wrapper.get('[data-graph-node="second"] [data-testid="graph-drag"]').trigger('dragstart', { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    await view.wrapper.setProps(kind === 'definition' ? { definition: structuredClone(definition) } : { disabled: true });
    await view.wrapper.setProps(kind === 'definition' ? { definition } : { disabled: false });
    await view.wrapper.get('[data-testid="graph-drop-end"]').trigger('drop');
    expect(view.edits).not.toHaveBeenCalled();
  });

  it('shows the existing multiselection rather than hiding other delete targets', async () => {
    using view = graph({ definition: { name: '', steps: [first, second] }, selectedId: second.id });
    await view.wrapper.setProps({ selectedIds: new Set([first.id, second.id]) });
    expect(view.wrapper.findAll('[data-testid="graph-select-node"]').map(button => button.attributes('aria-pressed'))).toEqual(['true', 'true']);
  });

  it('follows a selected Step moved into another scope without resetting ordinary child navigation', async () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    using view = graph({ definition: { name: '', steps: [second, loop] }, selectedId: second.id });
    await view.wrapper.setProps({ definition: { name: '', steps: [{ ...loop, body: { steps: [second] } }] } });
    expect(view.wrapper.findAll('[data-graph-node]').map(node => node.attributes('data-graph-node'))).toEqual(['second']);
    await view.wrapper.setProps({ definition: { name: 'renamed', steps: [{ ...loop, body: { steps: [second] } }] } });
    expect(view.wrapper.findAll('[data-graph-node]').map(node => node.attributes('data-graph-node'))).toEqual(['second']);
  });

  it('falls back safely when a viewed child scope is deleted', async () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    using view = graph({ definition: { name: '', steps: [loop] }, selectedId: undefined });
    await view.wrapper.get('[data-graph-branch="body"]').trigger('click');
    await view.wrapper.setProps({ definition: { name: '', steps: [first] } });
    expect(view.wrapper.find('[data-graph-node="first"]').exists()).toBe(true);
  });
});
