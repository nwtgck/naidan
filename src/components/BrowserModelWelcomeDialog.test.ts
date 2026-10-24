import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { modelLaunchCommand, setModelLaunchEntryState, TEST_ONLY as launchTest } from '@/features/llama-cpp-browser/model-launch/entry-state';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import LlamaCppBrowserModelConfiguration from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelConfiguration.vue';
import BrowserModelWelcomeDialog from './BrowserModelWelcomeDialog.vue';

enableAutoUnmount(afterEach);
const localInput = vi.hoisted(() => vi.fn());
const captureDrop = vi.hoisted(() => vi.fn());
const entry = {
  intent: ref({ kind: 'home', input: undefined as string | undefined }),
  interaction: ref('ready'),
  modelSelection: ref<{ phase: 'open' | 'closing', target: { kind: 'home' }, selection: { suggestionId: string, quantizationId: string } } | undefined>(),
  discovery: ref(undefined),
  closeModelSelection: vi.fn(),
  finishModelSelectionClose: vi.fn(),
  selectModel: vi.fn(),
  homeSelection: ref({ suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }),
  openDiscovery: vi.fn(),
  captureModelLaunchStartContext: () => ({ isCurrent: () => true }),
};
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => entry }));
vi.mock('@/composables/useLocalModelStart', () => ({ startLocalModelInput: localInput }));
vi.mock('@/features/llama-cpp-browser/logic/local-model-input', () => ({ captureDroppedLocalModels: captureDrop }));
vi.mock('./LocalModelSelectionDialog.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div />' } }));

beforeEach(async () => {
  launchTest.reset();
  entry.intent.value = { kind: 'home', input: undefined };
  entry.interaction.value = 'ready';
  entry.modelSelection.value = { phase: 'open', target: { kind: 'home' }, selection: entry.homeSelection.value };
  localInput.mockReset().mockResolvedValue(undefined);
  captureDrop.mockReset().mockResolvedValue([]);
  await ensureAllStringsForTest({ locale: 'en' });
});

function mountEntry() {
  return mount(BrowserModelWelcomeDialog, { global: { stubs: { teleport: true, BrowserModelWelcome: { template: '<div data-testid="welcome-model-surface" />' } } } });
}

it('shows a full-pane model drop hint and keeps it when moving between children', async () => {
  const wrapper = mountEntry();
  const pane = wrapper.get('[data-testid="welcome-model-surface"]');
  vi.spyOn(pane.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  await pane.trigger('dragover', { dataTransfer: { types: ['Files'], dropEffect: 'none' } });
  expect(wrapper.get('[data-testid="model-drop-overlay"]').text()).toContain('GGUF');
  await pane.trigger('dragleave', { clientX: 100, clientY: 100 });
  expect(wrapper.find('[data-testid="model-drop-overlay"]').exists()).toBe(true);
  await pane.trigger('dragleave', { clientX: 501, clientY: 100 });
  expect(wrapper.find('[data-testid="model-drop-overlay"]').exists()).toBe(false);
});

it('captures file entries during dispatch and clears the hint before opening local models', async () => {
  const wrapper = mountEntry();
  const pane = wrapper.get('[data-testid="welcome-model-surface"]');
  const dataTransfer = { types: ['Files'], dropEffect: 'none', items: [] };
  await pane.trigger('dragover', { dataTransfer });
  const dropped = pane.trigger('drop', { dataTransfer });
  expect(captureDrop).toHaveBeenCalledOnce();
  expect(captureDrop.mock.calls[0]?.[0].transfer).toBe(dataTransfer);
  await dropped;
  await flushPromises();
  expect(wrapper.find('[data-testid="model-drop-overlay"]').exists()).toBe(false);
  expect(localInput).toHaveBeenCalledOnce();
});

it('does not treat text drags, blocked startup or a closing dialog as a model drop', async () => {
  const wrapper = mountEntry();
  const pane = wrapper.get('[data-testid="welcome-model-surface"]');
  await pane.trigger('dragover', { dataTransfer: { types: ['text/plain'] } });
  expect(wrapper.find('[data-testid="model-drop-overlay"]').exists()).toBe(false);
  entry.interaction.value = 'blocked';
  await pane.trigger('drop', { dataTransfer: { types: ['Files'] } });
  expect(captureDrop).not.toHaveBeenCalled();
  entry.interaction.value = 'ready';
  entry.modelSelection.value = { phase: 'closing', target: { kind: 'home' }, selection: entry.homeSelection.value };
  await pane.trigger('dragover', { dataTransfer: { types: ['Files'] } });
  await pane.trigger('drop', { dataTransfer: { types: ['Files'] } });
  expect(captureDrop).not.toHaveBeenCalled();
});

it('does not accept Start from a card remaining in the closing animation', async () => {
  const wrapper = mountEntry();
  entry.modelSelection.value = { phase: 'closing', target: { kind: 'home' }, selection: entry.homeSelection.value };
  // The leaving DOM can still deliver a second activation before it is removed.
  wrapper.getComponent(BrowserModelWelcome).vm.$emit('start');
  expect(modelLaunchCommand.value).toBeUndefined();
  await flushPromises();
  expect(localInput).not.toHaveBeenCalled();
});

it('keeps companion choices inside the same dialog and retries a failed confirmed selection', async () => {
  const wrapper = mountEntry();
  const dialog = wrapper.get('[data-testid="browser-model-dialog"]').element;
  wrapper.getComponent(BrowserModelWelcome).vm.$emit('start');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected Start');
  }
  setModelLaunchEntryState({
    state: {
      status: 'needs-selection',
      operation: command.operation,
      input: 'owner/model',
      mainChoices: [{ path: 'model.gguf', label: 'Q4_K_M', size: 100 }],
      companionChoices: [{ path: 'mmproj.gguf', label: 'Vision', size: 20 }],
      companionRequirement: 'required',
      selectedMainPath: 'model.gguf',
      selectedCompanionPath: 'mmproj.gguf',
    },
  });
  await vi.waitFor(() => expect(wrapper.find('[data-testid="browser-model-files"]').exists()).toBe(true));
  expect(wrapper.get('[data-testid="browser-model-dialog"]').element).toBe(dialog);
  expect(entry.intent.value.kind).toBe('home');
  await wrapper.get('[data-testid="browser-model-files-confirm"]').trigger('click');
  expect(modelLaunchCommand.value).toMatchObject({ kind: 'confirm', operation: command.operation, mainFilePath: 'model.gguf', companionFilePath: 'mmproj.gguf', multimodal: 'on' });
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: 'owner/model', problem: 'failed' } });
  await flushPromises();
  expect(wrapper.getComponent(LlamaCppBrowserModelConfiguration).props('disabled')).toBe(true);
  await wrapper.get('[data-testid="browser-model-files-confirm"]').trigger('click');
  expect(modelLaunchCommand.value).toMatchObject({ kind: 'retry', operation: command.operation });
});
