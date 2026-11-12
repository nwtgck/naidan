import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import Panel from './ModelGraphDefinitionRegistryPanel.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ImportForm from './ModelGraphDefinitionImportForm.vue';
import StandardCodeBlock from '@/components/block-markdown/StandardCodeBlock.vue';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { graphFixture } from '@/features/llama-cpp-browser/model-graph/fixtures.test-support';
import { importModelGraphRegistrations } from '@/features/llama-cpp-browser/model-graph/registry';
import { modelGraphSourceDigest } from '@/01-models/model-graph-registry';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), clipboard: vi.fn(), download: vi.fn<({ blob, filename }: { blob: Blob; filename: string }) => void>() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/utils/stream-download', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/stream-download')>(), downloadBlob: mocks.download }));
vi.mock('@/features/highlight/worker/client-shared', async () => {
  const { escapeTextAsHtml } = await import('@/logic/security/allowedHtml');
  return {
    acquireSharedHighlightWorkerClientLease: async () => ({
      client: { highlight: async ({ request }: { request: { code: string } }) => ({ html: escapeTextAsHtml({ text: request.code }) }) },
      release: async () => {},
    }),
  };
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  await storageService.init({ type: 'memory' });
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.clipboard.mockReset().mockResolvedValue(undefined);
  mocks.download.mockReset();
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.clipboard } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function source({ name }: { name: string }): string {
  return JSON.stringify({ ...graphFixture().definition, name }, undefined, 2);
}

function otherSource(): string {
  const definition = graphFixture().definition;
  return JSON.stringify({ ...definition, name: 'Second', applicability: { ...definition.applicability, architecture: 'other' } }, undefined, 2);
}

async function blobText({ blob }: { blob: Blob }): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Expected text'));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
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

it('registers consecutive multiline objects for use after confirmation and retains the reviewed input', async () => {
  const input = source({ name: 'First' }) + '\n\n' + otherSource();
  using mounted = panel({ input });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  expect(wrapper.get('[data-testid="model-graph-preview"]').text()).toContain('First');
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="model-graph-registration"]')).toHaveLength(2));
  const saved = await storageService.loadModelGraphRegistry();
  expect(saved.registrations.map(entry => entry.rule.mode)).toEqual(['replace_native', 'replace_native']);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(wrapper.get<HTMLTextAreaElement>('[data-testid="model-graph-input"]').element.value).toBe(input);
  expect(wrapper.findAll('[data-testid="model-graph-preview-entry"]').every(entry => entry.text().includes('Registered'))).toBe(true);
  expect(wrapper.text()).not.toContain('arch.json');
});

it('does not partially register valid objects followed by invalid text', async () => {
  using mounted = panel({ input: source({ name: 'First' }) + '\nnot JSON' });
  await vi.waitFor(() => expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(true));
  expect(mounted.wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeDefined();
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
});

it('registers only the chosen definition and shows pending, registered, and conflicting states', async () => {
  const input = source({ name: 'First' }) + '\n\n' + source({ name: 'Second' });
  using mounted = panel({ input });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="model-graph-preview-entry"]')).toHaveLength(2));
  expect(wrapper.findAll('[data-testid="model-graph-preview-entry"]').every(entry => entry.text().includes('Not registered'))).toBe(true);
  expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeDefined();
  await wrapper.findAll('[data-testid="model-graph-register-entry"]')[1]!.trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations.map(entry => entry.label)).toEqual(['Second']));
  const saved = (await storageService.loadModelGraphRegistry()).registrations[0]!;
  expect(saved.rule).toEqual({ mode: 'replace_native', architecture: 'fixture', approvedSha256: saved.sourceSha256 });
  const entries = wrapper.findAll('[data-testid="model-graph-preview-entry"]');
  expect(entries[1]!.get('[role="status"]').text()).toBe('Registered');
  expect(entries[0]!.text()).toContain('already has an active definition');
  expect(entries.every(entry => entry.get('[data-testid="model-graph-register-entry"]').attributes('disabled') !== undefined)).toBe(true);
  expect(wrapper.get<HTMLTextAreaElement>('[data-testid="model-graph-input"]').element.value).toBe(input);
});

it('bulk-registers only the remaining definitions after an individual registration', async () => {
  const input = source({ name: 'First' }) + '\n\n' + otherSource();
  using mounted = panel({ input });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="model-graph-register-entry"]')).toHaveLength(2));
  await wrapper.findAll('[data-testid="model-graph-register-entry"]')[0]!.trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations).toHaveLength(1));
  const first = (await storageService.loadModelGraphRegistry()).registrations[0]!;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations).toHaveLength(2));
  const saved = (await storageService.loadModelGraphRegistry()).registrations;
  expect(saved[0]).toEqual(first);
  expect(saved.map(entry => entry.rule.mode)).toEqual(['replace_native', 'replace_native']);
});

it('does not register or clear input when registration confirmation is declined', async () => {
  const input = source({ name: 'First' });
  mocks.confirm.mockResolvedValue(false);
  using mounted = panel({ input });
  await vi.waitFor(() => expect(mounted.wrapper.get('[data-testid="model-graph-register-entry"]').attributes('disabled')).toBeUndefined());
  await mounted.wrapper.get('[data-testid="model-graph-register-entry"]').trigger('click');
  await flushPromises();
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
  expect(mounted.wrapper.get<HTMLTextAreaElement>('[data-testid="model-graph-input"]').element.value).toBe(input);
});

it('does not apply a registration approval after the input changes', async () => {
  const approval = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(approval.promise);
  using mounted = panel({ input: source({ name: 'First' }) });
  await vi.waitFor(() => expect(mounted.wrapper.get('[data-testid="model-graph-register-entry"]').attributes('disabled')).toBeUndefined());
  await mounted.wrapper.get('[data-testid="model-graph-register-entry"]').trigger('click');
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  mounted.wrapper.getComponent(Panel).vm.$emit('update:input', source({ name: 'Changed' }));
  await flushPromises();
  approval.resolve(true);
  await vi.waitFor(() => expect(mounted.wrapper.get('[role="alert"]').text()).toContain('input changed'));
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
});

it('rejects a stale registration event and a definition outside the reviewed input', async () => {
  using mounted = panel({ input: source({ name: 'Current' }) });
  await vi.waitFor(() => expect(mounted.wrapper.get('[data-testid="model-graph-register-entry"]').attributes('disabled')).toBeUndefined());
  mounted.wrapper.getComponent(ImportForm).vm.$emit('register', { input: source({ name: 'Previous' }), source: undefined });
  await vi.waitFor(() => expect(mounted.wrapper.get('[role="alert"]').text()).toContain('input changed'));
  mounted.wrapper.getComponent(ImportForm).vm.$emit('register', { input: source({ name: 'Current' }), source: source({ name: 'Foreign' }) });
  await vi.waitFor(() => expect(mounted.wrapper.get('[role="alert"]').text()).toContain('no longer in the input'));
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it('requires confirmation for native replacement, and copies source without authority', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findAll('[data-testid="model-graph-registration"]')).toHaveLength(1));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'replace_native');
  await flushPromises();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('replace_native'));
  await mounted.wrapper.get('[data-testid="model-graph-copy"]').trigger('click');
  await flushPromises();
  expect(mocks.clipboard).toHaveBeenCalledWith(source({ name: 'First' }));
  expect(mocks.clipboard.mock.calls[0]?.[0]).not.toContain('approvedSha256');
});

it('downloads the original JSON with a safe filename and without local execution authority', async () => {
  const input = source({ name: 'Graph/Example' });
  await saveInitial({ input });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.find('[data-testid="model-graph-download"]').exists()).toBe(true));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'replace_native');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('replace_native'));
  await mounted.wrapper.get('[data-testid="model-graph-download"]').trigger('click');
  const download = mocks.download.mock.calls[0]?.[0];
  if (!download) {
    throw new Error('Expected a JSON download');
  }
  expect(download.filename).toBe('Graph-Example.json');
  expect(download.blob.type).toBe('application/json');
  const text = await blobText({ blob: download.blob });
  expect(text).toBe(input);
  expect(text).not.toContain('approvedSha256');
  expect(text).not.toContain('replace_native');
});

it('reports a failed download without modifying the registered definition', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.find('[data-testid="model-graph-download"]').exists()).toBe(true));
  const before = await storageService.loadModelGraphRegistry();
  mocks.download.mockImplementationOnce(() => {
    throw new Error('Download failed');
  });
  await mounted.wrapper.get('[data-testid="model-graph-download"]').trigger('click');
  expect(mounted.wrapper.get('[role="alert"]').text()).toBe('Download failed');
  expect(await storageService.loadModelGraphRegistry()).toEqual(before);
});

it('does not enable the graph when native-replacement confirmation is declined', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  mocks.confirm.mockResolvedValue(false);
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findComponent(SettingsFormSelect).exists()).toBe(true));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'replace_native');
  await flushPromises();
  await flushPromises();
  expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('disabled');
  expect(mounted.wrapper.getComponent(SettingsFormSelect).props()).toMatchObject({ modelValue: 'disabled' });
});

it('keeps source inspection and confirmed deletion available in the registered list', async () => {
  const input = source({ name: 'First' });
  await saveInitial({ input });
  using mounted = panel({ input });
  const { wrapper } = mounted;
  await vi.waitFor(() => expect(wrapper.find('[data-testid="model-graph-source-toggle"]').exists()).toBe(true));
  const toggle = wrapper.get('[data-testid="model-graph-source-toggle"]');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect(wrapper.findComponent(StandardCodeBlock).exists()).toBe(false);
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(wrapper.getComponent(StandardCodeBlock).props()).toEqual({ code: input, lang: 'json' });
  expect(wrapper.get('[data-testid="model-graph-registration"] pre').text()).toBe(input);
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect(wrapper.findComponent(StandardCodeBlock).exists()).toBe(true);
  mocks.confirm.mockResolvedValue(false);
  await wrapper.get('[data-testid="model-graph-delete"]').trigger('click');
  await flushPromises();
  expect((await storageService.loadModelGraphRegistry()).registrations).toHaveLength(1);
  mocks.confirm.mockResolvedValue(true);
  await wrapper.get('[data-testid="model-graph-delete"]').trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations).toHaveLength(0));
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register-entry"]').attributes('disabled')).toBeUndefined());
  expect(wrapper.get('[data-testid="model-graph-preview-entry"]').text()).toContain('Not registered');
});

it('replacement resets approval and preserves registration identity', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  using mounted = panel({ input: source({ name: 'Updated' }) });
  await vi.waitFor(() => expect(mounted.wrapper.findComponent(SettingsFormSelect).exists()).toBe(true));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'replace_native');
  await flushPromises();
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('replace_native'));
  const previous = (await storageService.loadModelGraphRegistry()).registrations[0]!;
  await mounted.wrapper.get('[data-testid="model-graph-replace"]').trigger('click');
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
  await storageService.updateModelGraphRegistry({ access: snapshot.access, registrations: snapshot.registrations.map(entry => ({ ...entry, source: oldSource, sourceSha256: digest, rule: { mode: 'replace_native', architecture: 'fixture', approvedSha256: digest } })) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findComponent(SettingsFormSelect).exists()).toBe(true));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'disabled');
  await flushPromises();
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('disabled'));
});

it('stops a confirmation from rebasing onto another tab revision', async () => {
  await saveInitial({ input: source({ name: 'First' }) });
  const approval = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(approval.promise);
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findComponent(SettingsFormSelect).exists()).toBe(true));
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'replace_native');
  await flushPromises();
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
  read.resolve(otherSource());
  await vi.waitFor(() => expect(wrapper.get('[data-testid="model-graph-register"]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-testid="model-graph-register"]').trigger('click');
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations.map(entry => entry.label)).toEqual(['Existing', 'Draft', 'Second']));
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

it('retains and copies experimental-2 text without granting it experimental-3 authority', async () => {
  await saveInitial({ input: source({ name: 'Old format' }) });
  const snapshot = await storageService.loadModelGraphRegistry();
  const previous = { ...graphFixture().definition, format: 'naidan.model-graph/experimental-2' };
  const original = JSON.stringify(previous);
  const digest = modelGraphSourceDigest({ source: original });
  await storageService.updateModelGraphRegistry({ access: snapshot.access, registrations: snapshot.registrations.map(entry => ({ ...entry, source: original, sourceSha256: digest, rule: { mode: 'replace_native', architecture: 'fixture', approvedSha256: digest } })) });
  using mounted = panel({ input: '' });
  await vi.waitFor(() => expect(mounted.wrapper.findComponent(SettingsFormSelect).exists()).toBe(true));
  const current = await storageService.loadModelGraphRegistry();
  expect(current.registrations[0]!.source).toBe(original);
  await mounted.wrapper.get('[data-testid="model-graph-copy"]').trigger('click');
  expect(mocks.clipboard).toHaveBeenCalledWith(original);
  await mounted.wrapper.get('[data-testid="model-graph-download"]').trigger('click');
  const download = mocks.download.mock.calls[0]?.[0];
  if (!download) {
    throw new Error('Expected the unsupported source to remain downloadable');
  }
  expect(await blobText({ blob: download.blob })).toBe(original);
  mounted.wrapper.getComponent(SettingsFormSelect).vm.$emit('update:modelValue', 'disabled');
  await flushPromises();
  await vi.waitFor(async () => expect((await storageService.loadModelGraphRegistry()).registrations[0]?.rule.mode).toBe('disabled'));
  expect((await storageService.loadModelGraphRegistry()).registrations[0]!.source).toBe(original);
});
