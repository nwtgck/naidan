import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { CspHintMessage } from '@/logic/csp-message-hints/types';
import { modelLaunchCommand, setModelLaunchEntryState, TEST_ONLY as launchTest } from '@/features/llama-cpp-browser/model-launch/entry-state';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import LlamaCppBrowserModelConfiguration from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelConfiguration.vue';
import OnBoardingModalV2 from './OnBoardingModalV2.vue';

enableAutoUnmount(afterEach);
const localInput = vi.hoisted(() => vi.fn());
const captureDrop = vi.hoisted(() => vi.fn());
const captureFiles = vi.hoisted(() => vi.fn());
const initialViewCspHint = ref<CspHintMessage>();
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
  captureModelLaunchContext: () => ({ isCurrent: () => true }),
};
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => entry }));
// These owner tests control diagnostics locally rather than starting the
// document-header observation as an unrelated network side effect.
vi.mock('@/composables/useCspMessageHintsOnly', () => ({ useCspMessageHintsOnly: () => initialViewCspHint }));
vi.mock('@/composables/useLocalModelStart', () => ({ startLocalModelInput: localInput }));
vi.mock('@/features/llama-cpp-browser/logic/local-model-input', () => ({ captureDroppedLocalModels: captureDrop, localModelDirectoriesFromFiles: captureFiles }));
vi.mock('./LocalModelSelectionDialog.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div />' } }));
vi.mock('./BrowserConnectionSelection.vue', () => {
  throw new Error('Connection settings module failed to load');
});

beforeEach(async () => {
  launchTest.reset();
  entry.intent.value = { kind: 'home', input: undefined };
  entry.interaction.value = 'ready';
  entry.modelSelection.value = { phase: 'open', target: { kind: 'home' }, selection: entry.homeSelection.value };
  localInput.mockReset().mockResolvedValue(undefined);
  captureDrop.mockReset().mockResolvedValue([]);
  captureFiles.mockReset().mockReturnValue([]);
  initialViewCspHint.value = undefined;
  await ensureAllStringsForTest({ locale: 'en' });
});

function mountEntry() {
  return mount(OnBoardingModalV2, { global: { stubs: { teleport: true, BrowserModelWelcome: { template: '<div data-testid="welcome-model-surface" />' } } } });
}

function mountWelcomeEntry({ cspHint }: { cspHint: 'visible' | 'absent' }) {
  return mount(OnBoardingModalV2, {
    global: {
      stubs: {
        teleport: true,
        CspMessageHint: {
          props: ['target', 'activityForDisplayOnly', 'presentation'],
          template: cspHint === 'visible' ? '<details data-testid="welcome-csp-guidance" :data-target="target.kind" :data-activity="activityForDisplayOnly" :data-presentation="presentation"><summary>Preparation guidance</summary><p>Connection restrictions</p></details>' : '<!-- No CSP guidance -->',
        },
      },
    },
  });
}

it('lets people switch to local files and back before late CSP evidence arrives', async () => {
  const wrapper = mountWelcomeEntry({ cspHint: 'absent' });
  const toggle = wrapper.get('[data-testid="onboarding-local-model-toggle"]');
  expect(toggle.attributes('aria-pressed')).toBe('false');
  await toggle.trigger('click');
  await vi.waitFor(() => expect(wrapper.find('[data-testid="onboarding-local-model-input"]').exists()).toBe(true));
  const local = wrapper.get('[data-testid="onboarding-local-model-input"]');
  await ensureAllStringsForTest({ locale: 'en' });
  await flushPromises();
  expect(local.get('[data-testid="llama-import-mode-temp"]').text()).toBe('Load model');
  expect(local.get('[data-testid="llama-import-mode-host"]').text()).toBe('Link folder');
  expect(wrapper.get('[data-testid="model-swipe"]').isVisible()).toBe(false);
  expect(wrapper.find('[data-testid="open-connections"]').exists()).toBe(true);
  await wrapper.get('[data-testid="onboarding-showcase-toggle"]').trigger('click');
  expect(wrapper.get('[data-testid="onboarding-local-model-input"]').element).toBe(local.element);
  expect(local.isVisible()).toBe(false);
  expect(wrapper.get('[data-testid="onboarding-local-model-toggle"]').element).toBe(toggle.element);
  expect(wrapper.find('[data-testid="model-swipe"]').exists()).toBe(true);
  initialViewCspHint.value = { tone: 'caution', subject: 'huggingface', details: [], suggestedDeployments: [] };
  await flushPromises();
  expect(toggle.attributes('aria-pressed')).toBe('false');
  expect(wrapper.find('[data-testid="model-swipe"]').exists()).toBe(true);
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('defaults to local files with HF restriction evidence and keeps the cards manually available', async () => {
  initialViewCspHint.value = { tone: 'caution', subject: 'huggingface', details: [], suggestedDeployments: [] };
  const wrapper = mountWelcomeEntry({ cspHint: 'absent' });
  const toggle = wrapper.get('[data-testid="onboarding-local-model-toggle"]');
  expect(toggle.attributes('aria-pressed')).toBe('true');
  await vi.waitFor(() => expect(wrapper.find('[data-testid="onboarding-local-model-input"]').exists()).toBe(true));
  expect(wrapper.find('[data-testid="onboarding-local-model-input"]').exists()).toBe(true);
  await wrapper.get('[data-testid="onboarding-showcase-toggle"]').trigger('click');
  expect(toggle.attributes('aria-pressed')).toBe('false');
  expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeUndefined();
  initialViewCspHint.value = undefined;
  await flushPromises();
  expect(wrapper.find('[data-testid="model-swipe"]').exists()).toBe(true);
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('offers owned preparation failure guidance directly after the error without changing the model action', async () => {
  using fetch = vi.spyOn(globalThis, 'fetch');
  const wrapper = mountWelcomeEntry({ cspHint: 'visible' });
  const dialog = wrapper.get('[data-testid="browser-model-dialog"]').element;
  const start = wrapper.get('[data-testid="start-model"]').element;
  const content = wrapper.get<HTMLElement>('[data-testid="browser-model-dialog-content"]').element;
  Object.defineProperties(content, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  using _geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === content) {
      return new DOMRect(0, 100, 600, 200);
    }
    if (this.tagName === 'P' && this.parentElement?.dataset.testid === 'welcome-start-error') {
      return new DOMRect(0, 800 - content.scrollTop, 600, 20);
    }
    if (this.dataset.testid === 'hf-download-failure-trigger') {
      return new DOMRect(0, 840 - content.scrollTop, 600, 20);
    }
    return getRect.call(this);
  });
  const scroll = vi.fn(({ top }: { top: number, behavior: ScrollBehavior }) => {
    content.scrollTop = top;
  });
  Object.defineProperty(content, 'scrollTo', { configurable: true, value: scroll });
  expect(wrapper.get('[data-testid="welcome-csp-guidance"]').attributes()).toMatchObject({ 'data-target': 'huggingface-download', 'data-presentation': 'compact' });
  await wrapper.get('[data-testid="start-model"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected Start');
  }
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: command.request.input, problem: 'failed' } });
  await flushPromises();
  const error = wrapper.get('[data-testid="welcome-start-error"]');
  const failure = error.get('[data-testid="hf-download-failure-hint"]');
  expect(error.get('[role="alert"]').element.nextElementSibling).toBe(failure.element);
  expect(error.find('[data-testid="welcome-csp-guidance"]').exists()).toBe(false);
  expect(error.find('[data-testid="gguf-local-recovery"]').exists()).toBe(false);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 584, behavior: 'auto' });
  await failure.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  const guidance = error.get('[data-testid="welcome-csp-guidance"]');
  expect(error.get('[role="alert"]').element.nextElementSibling?.contains(guidance.element)).toBe(true);
  expect(guidance.attributes()).toMatchObject({ 'data-target': 'huggingface-download', 'data-activity': 'download', 'data-presentation': 'error-details' });
  expect(error.find('[data-testid="gguf-local-recovery"]').exists()).toBe(true);
  expect(wrapper.get('[data-testid="browser-model-dialog"]').element).toBe(dialog);
  expect(wrapper.get('[data-testid="start-model"]').element).toBe(start);
  expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeUndefined();
  expect(guidance.element.closest('.browser-model-dialog-content')).toBe(error.element.closest('.browser-model-dialog-content'));
  expect(modelLaunchCommand.value).toBe(command);
  expect(fetch).not.toHaveBeenCalled();

  const selection = entry.modelSelection.value;
  if (selection === undefined) {
    throw new Error('Expected an open selection');
  }
  selection.selection = { suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' };
  await flushPromises();
  expect(wrapper.find('[data-testid="welcome-csp-guidance"]').exists()).toBe(true);
  expect(modelLaunchCommand.value).toBe(command);
  expect(scroll).toHaveBeenCalledOnce();
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: command.request.input, problem: 'failed' } });
  await flushPromises();
  expect(scroll).toHaveBeenCalledOnce();
});

it('offers local GGUF recovery without CSP guidance and forwards only an explicit file choice to the existing owner', async () => {
  const wrapper = mountWelcomeEntry({ cspHint: 'absent' });
  await wrapper.get('[data-testid="start-model"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected Start');
  }
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: command.request.input, problem: 'failed' } });
  await flushPromises();
  expect(wrapper.find('[data-testid="gguf-local-recovery"]').exists()).toBe(false);
  await wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  const recovery = wrapper.get('[data-testid="welcome-start-error"]').get('[data-testid="gguf-local-recovery"]');
  expect(wrapper.find('[data-testid="welcome-csp-guidance"]').exists()).toBe(false);
  expect(localInput).not.toHaveBeenCalled();
  expect(captureFiles).not.toHaveBeenCalled();
  expect(modelLaunchCommand.value).toBe(command);

  const file = new File(['model'], 'model.gguf');
  const input = recovery.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
  entry.interaction.value = 'blocked';
  await flushPromises();
  expect(input.attributes('disabled')).toBeDefined();
  entry.interaction.value = 'ready';
  await flushPromises();
  expect(recovery.get('[data-testid="llama-cpp-browser-file"]').element).toBe(input.element);
  expect(input.attributes('disabled')).toBeUndefined();
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  await input.trigger('change');
  await vi.waitFor(() => expect(localInput).toHaveBeenCalledOnce());
  expect(captureFiles).toHaveBeenCalledWith({ files: [file], selection: 'files' });
  expect(localInput.mock.calls[0]?.[0]).toMatchObject({ directories: expect.any(Promise), controller: expect.any(AbortController), context: { isCurrent: expect.any(Function) } });
  expect(modelLaunchCommand.value).toBe(command);
});

it.each(['invalid-input', 'variant-unavailable', 'companion-required'] as const)('keeps a known preparation problem separate from connection guidance: %s', async problem => {
  const wrapper = mountWelcomeEntry({ cspHint: 'visible' });
  await wrapper.get('[data-testid="start-model"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected Start');
  }
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: command.request.input, problem } });
  await flushPromises();
  expect(wrapper.get('[data-testid="welcome-start-error"]').get('[role="alert"]').text()).not.toBe('');
  expect(wrapper.find('[data-testid="welcome-csp-guidance"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="hf-download-failure-hint"]').exists()).toBe(false);
});

it('ignores another model attempt when deciding whether welcome needs failure guidance', async () => {
  const wrapper = mountWelcomeEntry({ cspHint: 'visible' });
  const preflight = wrapper.get('[data-testid="welcome-csp-guidance"]');
  setModelLaunchEntryState({ state: { status: 'failed', operation: Symbol('another model attempt'), input: 'owner/another-model', problem: 'failed' } });
  await flushPromises();
  expect(wrapper.find('[data-testid="welcome-start-error"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="welcome-csp-guidance"]').element).toBe(preflight.element);
  expect(preflight.attributes('data-presentation')).toBe('compact');
  expect(wrapper.find('[data-testid="hf-download-failure-hint"]').exists()).toBe(false);
});

it.each(['openai', 'browser_provided_lm'] as const)('does not present a connection UI loading failure as an HF failure: %s', async endpoint => {
  const wrapper = mountWelcomeEntry({ cspHint: 'visible' });
  wrapper.getComponent(BrowserModelWelcome).vm.$emit('open-connections', endpoint);
  await vi.waitFor(() => expect(wrapper.getComponent(BrowserModelWelcome).props('startError')).toBe('Could not open connection settings. Please try again.'));
  expect(wrapper.find('[data-testid="welcome-csp-guidance"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="hf-download-failure-hint"]').exists()).toBe(false);
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('does not present a local file opening failure as an HF failure', async () => {
  using error = vi.spyOn(console, 'error').mockImplementation(() => {});
  localInput.mockRejectedValueOnce(new Error('Could not read the local file'));
  const wrapper = mountWelcomeEntry({ cspHint: 'visible' });
  const preflight = wrapper.get('[data-testid="welcome-csp-guidance"]');
  wrapper.getComponent(BrowserModelWelcome).vm.$emit('local-input', { directories: Promise.resolve([]), controller: new AbortController() });
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(localInput).toHaveBeenCalledOnce();
  expect(wrapper.getComponent(BrowserModelWelcome).props('startError')).toBeUndefined();
  expect(wrapper.get('[data-testid="welcome-csp-guidance"]').element).toBe(preflight.element);
  expect(preflight.attributes('data-presentation')).toBe('compact');
  expect(wrapper.find('[data-testid="hf-download-failure-hint"]').exists()).toBe(false);
  expect(modelLaunchCommand.value).toBeUndefined();
});

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
