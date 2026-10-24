import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import BrowserConnectionSelection from './BrowserConnectionSelection.vue';
import BrowserModelWelcomeDialog from './BrowserModelWelcomeDialog.vue';

enableAutoUnmount(afterEach);
const applySelection = vi.hoisted(() => vi.fn());
const waitForPaint = vi.hoisted(() => vi.fn());
const owner = ref(0);
const initialSelection = { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' };
const entry = {
  intent: ref({ kind: 'home' }),
  interaction: ref<'ready' | 'blocked'>('ready'),
  modelSelection: ref<{ phase: 'open' | 'closing', target: { kind: 'home' }, selection: typeof initialSelection }>({ phase: 'open', target: { kind: 'home' }, selection: initialSelection }),
  homeSelection: ref(initialSelection),
  discovery: ref(undefined),
  selectModel: vi.fn(),
  openDiscovery: vi.fn(),
  closeModelSelection: vi.fn(),
  finishModelSelectionClose: vi.fn(),
  captureModelLaunchContext: () => {
    const captured = owner.value;
    return { isCurrent: () => captured === owner.value };
  },
};
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => entry }));
vi.mock('@/logic/startup/presentation-frame', () => ({ waitForPresentationPaint: waitForPaint }));
vi.mock('@/logic/apply-model-connection', () => ({ applyModelConnectionSelection: applySelection }));
vi.mock('./BrowserConnectionSelection.vue', () => ({
  default: {
    name: 'BrowserConnectionSelection',
    props: ['initialEndpoint', 'active', 'applySelection'],
    emits: ['back'],
    template: '<div data-testid="connection-form" />',
  },
}));

beforeEach(async () => {
  owner.value++;
  entry.interaction.value = 'ready';
  entry.modelSelection.value = { phase: 'open', target: { kind: 'home' }, selection: initialSelection };
  entry.closeModelSelection.mockClear();
  entry.selectModel.mockClear();
  waitForPaint.mockReset().mockResolvedValue(undefined);
  applySelection.mockReset().mockResolvedValue(undefined);
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.unstubAllGlobals());

function renderDialog() {
  return mount(BrowserModelWelcomeDialog, { global: { stubs: { teleport: true } } });
}

async function openConnectionForm({ wrapper }: { wrapper: ReturnType<typeof renderDialog> }) {
  wrapper.getComponent(BrowserModelWelcome).vm.$emit('open-connections', 'openai');
  await vi.waitFor(() => expect(wrapper.findComponent(BrowserConnectionSelection).exists()).toBe(true));
  return wrapper.getComponent(BrowserConnectionSelection);
}

it('paints the GGUF cards before capability checks and appends a browser card without create or HTTP', async () => {
  using fetch = vi.spyOn(globalThis, 'fetch');
  const painted = Promise.withResolvers<void>();
  waitForPaint.mockReturnValue(painted.promise);
  const availability = vi.fn().mockResolvedValue('available');
  const create = vi.fn();
  vi.stubGlobal('LanguageModel', { availability, create });
  const wrapper = renderDialog();
  await nextTick();
  expect(wrapper.findAll('.model-deck-card')).toHaveLength(6);
  expect(availability).not.toHaveBeenCalled();
  const original = wrapper.get('[data-testid="start-model"]').element;
  painted.resolve();
  await vi.waitFor(() => expect(wrapper.findAll('.model-deck-card')).toHaveLength(7));
  expect(wrapper.get('[data-testid="start-model"]').element).toBe(original);
  expect(entry.selectModel).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['unavailable', 'downloadable', 'downloading'] as const)('only showcases browser models with supported availability: %s', async state => {
  const create = vi.fn();
  const availability = vi.fn().mockResolvedValue(state);
  vi.stubGlobal('LanguageModel', { availability, create });
  const wrapper = renderDialog();
  await vi.waitFor(() => expect(availability).toHaveBeenCalledOnce());
  await flushPromises();
  expect(wrapper.getComponent(BrowserModelWelcome).props('browserProvidedModel')?.availability).toBe(state === 'unavailable' ? undefined : state);
  expect(wrapper.findAll('.model-deck-card')).toHaveLength(state === 'unavailable' ? 6 : 7);
  expect(create).not.toHaveBeenCalled();
});

it('ignores an old capability result after the target changes', async () => {
  const old = Promise.withResolvers<string>();
  const availability = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('unavailable');
  vi.stubGlobal('LanguageModel', { availability, create: vi.fn() });
  const wrapper = renderDialog();
  await vi.waitFor(() => expect(availability).toHaveBeenCalledOnce());
  entry.modelSelection.value = { phase: 'open', target: { kind: 'home' }, selection: initialSelection };
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(2));
  old.resolve('available');
  await flushPromises();
  expect(wrapper.findAll('.model-deck-card')).toHaveLength(6);
});

it('opens and returns from connection settings without saving', async () => {
  const wrapper = renderDialog();
  const form = await openConnectionForm({ wrapper });
  expect(form.props('initialEndpoint')).toBe('openai');
  expect(form.props('active')).toBe(true);
  expect(applySelection).not.toHaveBeenCalled();
  form.vm.$emit('back');
  await flushPromises();
  expect(wrapper.findComponent(BrowserModelWelcome).exists()).toBe(true);
  expect(entry.closeModelSelection).not.toHaveBeenCalled();
});

it('prevents closing during the short commit and closes after applying to the captured target', async () => {
  const saved = Promise.withResolvers<void>();
  applySelection.mockReturnValue(saved.promise);
  const wrapper = renderDialog();
  const form = await openConnectionForm({ wrapper });
  const endpoint = { type: 'openai' as const, url: 'https://example.invalid/v1' };
  const saving = form.props('applySelection')({ endpoint, modelId: 'remote-model' });
  await vi.waitFor(() => expect(applySelection).toHaveBeenCalledOnce());
  expect(applySelection).toHaveBeenCalledWith({ target: entry.modelSelection.value.target, endpoint, modelId: 'remote-model', isCurrent: expect.any(Function) });
  expect(wrapper.get('[data-testid="browser-model-dialog-close"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="browser-model-dialog-close"]').trigger('click');
  form.vm.$emit('back');
  await nextTick();
  expect(wrapper.findComponent(BrowserConnectionSelection).exists()).toBe(true);
  expect(entry.closeModelSelection).not.toHaveBeenCalled();
  expect(form.props('active')).toBe(true);
  saved.resolve();
  await saving;
  expect(entry.closeModelSelection).toHaveBeenCalledOnce();
});

it('keeps the form active after a failed commit and rejects a later action from an expired owner', async () => {
  const wrapper = renderDialog();
  const form = await openConnectionForm({ wrapper });
  const choice = { endpoint: { type: 'ollama' as const, url: 'http://localhost:11434' }, modelId: 'local-model' };
  applySelection.mockRejectedValueOnce(new Error('storage write failed'));
  await expect(form.props('applySelection')(choice)).rejects.toThrow('storage write failed');
  expect(entry.closeModelSelection).not.toHaveBeenCalled();
  expect(form.props('active')).toBe(true);
  await nextTick();
  expect(wrapper.get('[data-testid="browser-model-dialog-close"]').attributes('disabled')).toBeUndefined();
  const oldApply = form.props('applySelection');
  owner.value++;
  await expect(oldApply(choice)).rejects.toThrow('no longer active');
  await vi.waitFor(() => expect(wrapper.getComponent(BrowserConnectionSelection).props('active')).toBe(false));
  expect(applySelection).toHaveBeenCalledOnce();
});

it('keeps a new target interactive and does not let an old commit unlock the new commit', async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  applySelection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const wrapper = renderDialog();
  const oldForm = await openConnectionForm({ wrapper });
  const choice = { endpoint: { type: 'openai' as const, url: 'https://example.invalid' }, modelId: 'remote-model' };
  const oldSaving = oldForm.props('applySelection')(choice);
  const oldOutcome = expect(oldSaving).rejects.toThrow('no longer active');
  await vi.waitFor(() => expect(applySelection).toHaveBeenCalledOnce());
  entry.modelSelection.value = { phase: 'open', target: { kind: 'home' }, selection: initialSelection };
  await nextTick();
  expect(wrapper.get('[data-testid="browser-model-dialog-close"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeUndefined();
  const newForm = await openConnectionForm({ wrapper });
  const newSaving = newForm.props('applySelection')(choice);
  await vi.waitFor(() => expect(applySelection).toHaveBeenCalledTimes(2));
  first.resolve();
  await oldOutcome;
  await nextTick();
  expect(wrapper.get('[data-testid="browser-model-dialog-close"]').attributes('disabled')).toBeDefined();
  expect(entry.closeModelSelection).not.toHaveBeenCalled();
  second.resolve();
  await newSaving;
  expect(entry.closeModelSelection).toHaveBeenCalledOnce();
});
