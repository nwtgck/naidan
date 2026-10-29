import { previewTest, repositoryCatalog, resetRepositoryPreviewTest } from './repository-preview.test-support';
import { downloadDestinationControl, modelConfigurationControl } from './model-configuration.test-support';
import { beforeEach, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { modelLaunchCommand, modelLaunchEntryState, setModelLaunchEntryState, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import LlamaCppBrowserRepositoryPreview from './LlamaCppBrowserRepositoryPreview.vue';

beforeEach(async () => {
  TEST_ONLY.reset();
  resetRepositoryPreviewTest();
  await ensureAllStringsForTest({ locale: 'en' });
});

function mountPreview({ input }: { input: string }) {
  const wrapper = mount(LlamaCppBrowserRepositoryPreview, {
    props: { input, active: true, disabled: false, operation: undefined, selectionTarget: undefined },
    global: { stubs: { CspMessageHint: true, HuggingFaceDownloadFailureHint: true } },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('inspects the explicitly selected repository, preselects the shared default and displays its actual size', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
  expect(modelConfigurationControl({ view: view.wrapper, field: 'quantization' }).props('modelValue')).toBe('Model-Q4_K_M.gguf');
  expect(view.wrapper.get('[data-testid="repository-preview-size"]').text()).toBe('256 B');
  expect(view.wrapper.get('[data-testid="repository-preview-memory"]').text()).toBe('Not estimated');
  expect(previewTest.permission).not.toHaveBeenCalled();
  expect(modelLaunchEntryState.value.status).toBe('idle');
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('updates size from the selected real quantization without repeating metadata requests', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF:Q8_0' });
  await flushPromises();
  const control = modelConfigurationControl({ view: view.wrapper, field: 'quantization' });
  expect(control.props('modelValue')).toBe('Model-Q8_0.gguf');
  expect(view.wrapper.get('[data-testid="repository-preview-size"]').text()).toBe('512 B');
  await control.setValue('Model-Q4_K_M.gguf');
  await flushPromises();
  expect(view.wrapper.get('[data-testid="repository-preview-size"]').text()).toBe('256 B');
  expect(previewTest.inspect).toHaveBeenCalledOnce();
});

it('continues a selected repository after a transient interaction lock without refreshing on later unlocks', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPreview, {
    props: { input: 'owner/Model-GGUF', active: true, disabled: true, operation: undefined, selectionTarget: undefined },
    global: { stubs: { CspMessageHint: true, HuggingFaceDownloadFailureHint: true } },
  });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(previewTest.inspect).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: false });
  await flushPromises();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="repository-preview-size"]').text()).toBe('256 B');
  await wrapper.setProps({ disabled: true });
  await wrapper.setProps({ disabled: false });
  await flushPromises();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
});

it('keeps an unavailable explicit quantization unresolved instead of substituting a default', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF:Q6_K' });
  await flushPromises();
  expect(modelConfigurationControl({ view: view.wrapper, field: 'quantization' }).props('modelValue')).toBe('');
  expect(view.wrapper.get<HTMLButtonElement>('[data-testid="discovery-start"]').element.disabled).toBe(true);
  await modelConfigurationControl({ view: view.wrapper, field: 'quantization' }).setValue('Model-Q4_K_M.gguf');
  await flushPromises();
  expect(view.wrapper.get<HTMLButtonElement>('[data-testid="discovery-start"]').element.disabled).toBe(false);
});

it('resolves ambiguous companions in this detail and starts the exact pinned files without a later selection step', async () => {
  const catalog = repositoryCatalog({ repository: 'owner/Model-GGUF' });
  catalog.projectors = [{ path: 'first-mmproj-F16.gguf', size: 64 }, { path: 'second-mmproj-F16.gguf', size: 128 }];
  previewTest.inspect.mockResolvedValue(catalog);
  using view = mountPreview({ input: catalog.repository });
  await flushPromises();
  expect(view.wrapper.get<HTMLButtonElement>('[data-testid="discovery-start"]').element.disabled).toBe(true);
  await modelConfigurationControl({ view: view.wrapper, field: 'companion' }).setValue(catalog.projectors[1]!.path);
  await flushPromises();
  expect(view.wrapper.get('[data-testid="repository-preview-size"]').text()).toBe('384 B');
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  expect(modelLaunchCommand.value).toMatchObject({ kind: 'start', target: { mainFilePath: 'Model-Q4_K_M.gguf', selection: { revision: catalog.revision, files: [catalog.models[1]!.files[0], catalog.projectors[1]] } } });
  expect(previewTest.inspect).toHaveBeenCalledOnce();
});

it('uses the selected linked folder and starts write authorization in the click call', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  expect(previewTest.installed).toHaveBeenLastCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'root-a' } }));
  expect(previewTest.permission).not.toHaveBeenCalled();
  view.wrapper.get('[data-testid="discovery-start"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(previewTest.permission).toHaveBeenCalledOnce();
  const command = modelLaunchCommand.value;
  expect(command).toMatchObject({ kind: 'start', request: { destination: { kind: 'host', directoryId: 'root-a' } } });
  if (command?.kind !== 'start') {
    throw new Error('Expected prepared Start');
  }
  await expect(command.authorization).resolves.toMatchObject({ destination: { kind: 'host', directoryId: 'root-a' }, expectedRoot: previewTest.root });
  expect(previewTest.inspect).toHaveBeenCalledOnce();
});

it('uses a saved host model with read access and no write permission prompt', async () => {
  previewTest.installed.mockResolvedValue({ modelId: 'host/Models/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 });
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  expect(view.wrapper.find('[data-testid="repository-preview-saved"]').exists()).toBe(true);
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected prepared Start');
  }
  await expect(command.authorization).resolves.toMatchObject({ expectedRoot: previewTest.root });
  expect(previewTest.rootRead).toHaveBeenLastCalledWith({ destination: { kind: 'host', directoryId: 'root-a' }, mode: 'read' });
  expect(previewTest.permission).not.toHaveBeenCalled();
});

it('gets a fresh authorization on retry after permission rejection', async () => {
  previewTest.permission.mockRejectedValueOnce(new Error('Denied'));
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected prepared Start');
  }
  await expect(command.authorization).rejects.toThrow('Denied');
  await view.wrapper.setProps({ operation: command.operation });
  setModelLaunchEntryState({ state: { status: 'failed', operation: command.operation, input: command.request.input, problem: 'failed' } });
  await flushPromises();
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  expect(previewTest.permission).toHaveBeenCalledTimes(2);
  const retry = modelLaunchCommand.value;
  if (retry?.kind !== 'start') {
    throw new Error('Expected fresh Start');
  }
  expect(retry.operation).not.toBe(command.operation);
  await expect(retry.authorization).resolves.toMatchObject({ destination: command.request.destination });
});

it('does not turn inaccessible folder files into missing OPFS files', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  previewTest.rootRead.mockRejectedValue(new Error('Read denied'));
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  expect(view.wrapper.get<HTMLButtonElement>('[data-testid="discovery-start"]').element.disabled).toBe(true);
  expect(downloadDestinationControl({ view: view.wrapper }).props('modelValue')).toBe('host:root-a');
  expect(previewTest.permission).not.toHaveBeenCalled();
});

it('aborts metadata when hidden and discards a late response', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  previewTest.inspect.mockReturnValue(pending.promise);
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  const signal: AbortSignal = previewTest.inspect.mock.calls[0]![0].signal;
  await view.wrapper.setProps({ active: false });
  expect(signal.aborted).toBe(true);
  pending.resolve(repositoryCatalog({ repository: 'owner/Model-GGUF' }));
  await flushPromises();
  expect(previewTest.installed).not.toHaveBeenCalled();
  expect(view.wrapper.find('[data-testid="llama-host-model-directories"]').exists()).toBe(false);
});

it('shows an inline metadata retry without starting a model operation', async () => {
  previewTest.inspect.mockRejectedValueOnce(new Error('Network failed'));
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  expect(view.wrapper.find('[data-testid="repository-preview-error"]').exists()).toBe(true);
  await view.wrapper.get('[data-testid="repository-preview-retry"]').trigger('click');
  await flushPromises();
  expect(previewTest.inspect).toHaveBeenCalledTimes(2);
  expect(view.wrapper.find('[data-testid="llama-host-model-directories"]').exists()).toBe(true);
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('rejects a different physical root when starting a saved host selection', async () => {
  previewTest.installed.mockResolvedValue({ modelId: 'host/Models/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 });
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  previewTest.rootRead.mockResolvedValue({ isSameEntry: async () => false });
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  const command = modelLaunchCommand.value;
  if (command?.kind !== 'start') {
    throw new Error('Expected prepared Start');
  }
  await expect(command.authorization).rejects.toThrow('destination changed');
  expect(previewTest.permission).not.toHaveBeenCalled();
});

it('discards a saved-file result from a previously selected destination', async () => {
  const pending = Promise.withResolvers<undefined | { modelId: string, size: number, importedAt: number }>();
  previewTest.installed.mockReturnValueOnce(pending.promise);
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await downloadDestinationControl({ view: view.wrapper }).setValue('host:root-a');
  await flushPromises();
  pending.resolve({ modelId: 'hf.co/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 });
  await flushPromises();
  expect(view.wrapper.find('[data-testid="repository-preview-saved"]').exists()).toBe(false);
  await view.wrapper.get('[data-testid="discovery-start"]').trigger('click');
  expect(previewTest.permission).toHaveBeenCalledOnce();
});

it('discards metadata for a replaced repository even when the response ignores abort', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  previewTest.inspect.mockReturnValueOnce(pending.promise);
  using view = mountPreview({ input: 'owner/old' });
  await flushPromises();
  const signal: AbortSignal = previewTest.inspect.mock.calls[0]![0].signal;
  await view.wrapper.setProps({ input: 'owner/new' });
  await flushPromises();
  pending.resolve(repositoryCatalog({ repository: 'owner/old' }));
  await flushPromises();
  expect(signal.aborted).toBe(true);
  expect(view.wrapper.text()).toContain('owner/new');
  expect(view.wrapper.text()).not.toContain('owner/old');
});

it('reuses folder management inside the detail without triggering metadata or a download', async () => {
  using view = mountPreview({ input: 'owner/Model-GGUF' });
  await flushPromises();
  await view.wrapper.get('[data-testid="llama-manage-model-directories"]').trigger('click');
  expect(view.wrapper.get('[data-testid="llama-model-directory-registrations"]').attributes('aria-hidden')).toBe('false');
  await view.wrapper.get('[data-testid="linked-add-model-directory"]').trigger('click');
  expect(previewTest.add).toHaveBeenCalledOnce();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
  expect(modelLaunchCommand.value).toBeUndefined();
});

it('uses editorial memory hints only for their exact named variant and accounts for multimodal support', async () => {
  const catalog: RepositoryCatalog = { repository: 'lmstudio-community/gemma-4-E2B-it-GGUF', revision: 'a'.repeat(40), projectors: [{ path: 'mmproj-F16.gguf', size: 64 }], models: [{ label: 'Q4_K_M', size: 256, files: [{ path: 'gemma-4-E2B-it-Q4_K_M.gguf', size: 256 }] }] };
  previewTest.inspect.mockResolvedValue(catalog);
  using view = mountPreview({ input: catalog.repository });
  await flushPromises();
  expect(view.wrapper.get('[data-testid="repository-preview-memory"]').text()).toBe('16 GiB');
  await view.wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
  expect(view.wrapper.get('[data-testid="repository-preview-memory"]').text()).toBe('8 GiB');
  previewTest.inspect.mockResolvedValue({ ...catalog, models: [{ label: 'UD-Q4_K_M', size: 256, files: [{ path: 'gemma-4-E2B-it-UD-Q4_K_M.gguf', size: 256 }] }] });
  await view.wrapper.setProps({ input: `${catalog.repository}:UD-Q4_K_M` });
  await flushPromises();
  expect(view.wrapper.get('[data-testid="repository-preview-memory"]').text()).toBe('Not estimated');
});
