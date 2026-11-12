import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import Panel from './ModelGraphDefinitionRegistryPanel.vue';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { graphFixture } from '@/features/llama-cpp-browser/model-graph/fixtures.test-support';
import { importModelGraphRegistrations } from '@/features/llama-cpp-browser/model-graph/registry';
import { modelGraphSourceDigest } from '@/01-models/model-graph-registry';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), clipboard: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  await storageService.init({ type: 'memory' });
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.clipboard.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.clipboard } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function source({ name }: { name: string }): string {
  return JSON.stringify({ ...graphFixture().definition, name }, undefined, 2);
}

function panel({ input }: { input: string }) {
  const wrapper = mount(defineComponent({
    components: { Panel },
    setup: () => ({ input: ref(input) }),
    template: '<Panel v-model:input="input" />',
  }));
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

async function saveInitial({ input }: { input: string }): Promise<void> {
  const current = await storageService.loadModelGraphRegistry();
  await storageService.updateModelGraphRegistry({ access: current.access, registrations: importModelGraphRegistrations({ input, existing: [] }) });
}

it('registers consecutive multiline objects together, initially without execution permission', async () => {
  using mounted = panel({ input: source({ name: 'First' }) + '\n\n' + source({ name: 'Second' }) });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  expect(wrapper.get('[data-testid="model-graph-preview"]').text()).toContain('First');
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="model-graph-registration"]')).toHaveLength(2));
  const saved = await storageService.loadModelGraphRegistry();
  expect(saved.registrations.map(entry => entry.rule.mode)).toEqual(['disabled', 'disabled']);
  expect(wrapper.get<HTMLTextAreaElement>('[data-testid="model-graph-input"]').element.value).toBe('');
  expect(wrapper.text()).not.toContain('arch.json');
});

it('does not partially register valid objects followed by invalid text', async () => {
  using mounted = panel({ input: source({ name: 'First' }) + '\nnot JSON' });
  await vi.waitFor(() => expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(true));
  expect(mounted.wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeDefined();
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
});

it('requires confirmation for native replacement, and copies source without authority', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findAll('[data-testid="model-graph-registration"]')).toHaveLength(1));
  await mounted.wrapper.get('select').setValue('replaceNative');
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('replaceNative'));
  const copy = mounted.wrapper.get('[data-testid="model-graph-registration"]').findAll('button').find(button => button.text().includes('Copy definitions'));
  await copy!.trigger('click');
  await flushPromises();
  expect(mocks.clipboard).toHaveBeenCalledWith(source({ name: 'First' }));
  expect(mocks.clipboard.mock.calls[0]?.[0]).not.toContain('approvedSha256');
});

it('does not enable the graph when native-replacement confirmation is declined', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  mocks.confirm.mockResolvedValue(false);
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.find('select').exists()).toBe(true));
  await mounted.wrapper.get('select').setValue('replaceNative');
  await flushPromises();
  expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('disabled');
  expect(mounted.wrapper.get<HTMLSelectElement>('select').element.value).toBe('disabled');
});

it('replacement resets approval and preserves registration identity', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  using mounted = panel({ input: source({ name: 'Updated' }) });
  await vi.waitFor(() => expect(mounted.wrapper.find('select').exists()).toBe(true));
  await mounted.wrapper.get('select').setValue('replaceNative');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('replaceNative'));
  const previous = (await storageService.loadModelGraphRegistry()).registrations[0]!;
  const replace = mounted.wrapper.get('[data-testid="model-graph-registration"]').findAll('button').find(button => button.text().includes('Replace with the input'));
  await replace!.trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.label).toBe('Updated'));
  const next = (await storageService.loadModelGraphRegistry()).registrations[0]!;
  expect(next.id).toBe(previous.id);
  expect(next.rule).toEqual({ mode: 'disabled' });
});

it('can disable and copy an old unsupported declaration without parsing it', async () => {
  await saveInitial({ input: source({ name: 'Old' }) });
  const snapshot = await storageService.loadModelGraphRegistry();
  const oldSource = '{"format":"retired"}';
  const digest = modelGraphSourceDigest({ source: oldSource });
  await storageService.updateModelGraphRegistry({ access: snapshot.access, registrations: snapshot.registrations.map(entry => ({ ...entry, source: oldSource, sourceSha256: digest, rule: { mode: 'replaceNative', architecture: 'fixture', approvedSha256: digest } })) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.find('select').exists()).toBe(true));
  await mounted.wrapper.get('select').setValue('disabled');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('disabled'));
});

it('stops a confirmation from rebasing onto another tab revision', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  const approval = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(approval.promise);
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.find('select').exists()).toBe(true));
  await mounted.wrapper.get('select').setValue('replaceNative');
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  const other = await storageService.loadModelGraphRegistry();
  await storageService.updateModelGraphRegistry({ access: other.access, registrations: [] });
  approval.resolve(true);
  await vi.waitFor(() => expect(mounted.wrapper.get('[role="alert"]').text()).toContain('changed'));
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
});

it('leaves unreadable persisted data untouched and exposes the read-only failure', async () => {
  const load = vi.spyOn(storageService, 'loadModelGraphRegistry').mockRejectedValue(new Error('corrupt registry'));
  const save = vi.spyOn(storageService, 'updateModelGraphRegistry');
  using mounted = panel({ input: source({ name: 'Recovery' }) });
  await vi.waitFor(() => expect(mounted.wrapper.get('[role="alert"]').text()).toContain('corrupt registry'));
  expect(mounted.wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalled();
});

it('locks registration and replacement while files are being read', async () => {
  await saveInitial({ input: source({ name: 'Existing' }) });
  using mounted = panel({ input: source({ name: 'Draft' }) });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  const read = Promise.withResolvers<string>();
  const file = new File(['{}'], 'definition.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => read.promise });
  const picker = wrapper.get<HTMLInputElement>('[data-testid="model-graph-files"]');
  Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] });
  const save = vi.spyOn(storageService, 'updateModelGraphRegistry');
  await picker.trigger('change');
  expect(picker.attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="model-graph-input"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="model-graph-usage-rule"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="model-graph-registration"]').findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  expect(save).not.toHaveBeenCalled();
  read.resolve(source({ name: 'File' }));
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations.map(entry => entry.label)).toEqual(['Existing', 'Draft', 'File']));
});

it('unlocks file input after a failed read without clearing the draft', async () => {
  using mounted = panel({ input: source({ name: 'Draft' }) });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  const file = new File(['{}'], 'definition.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    value: async () => {
      throw new Error('unreadable file');
    },
  });
  const picker = wrapper.get<HTMLInputElement>('[data-testid="model-graph-files"]');
  Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] });
  await picker.trigger('change');
  await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('unreadable file'));
  expect(picker.attributes('disabled')).toBeUndefined();
  expect(wrapper.get<HTMLTextAreaElement>('[data-testid="model-graph-input"]').element.value).toBe(source({ name: 'Draft' }));
});
