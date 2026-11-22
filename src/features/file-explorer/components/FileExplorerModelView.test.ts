import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelWeightDetails } from '@/logic/model-file-inspection/metadata';
import type { FileExplorerModelAccess } from '@/features/file-explorer/worker/types';
import FileExplorerModelView from './FileExplorerModelView.vue';

const access = {
  inspectModelOverview: vi.fn<FileExplorerModelAccess['inspectModelOverview']>(),
  inspectModel: vi.fn<FileExplorerModelAccess['inspectModel']>(),
  readModelMetadataValue: vi.fn<FileExplorerModelAccess['readModelMetadataValue']>(),
  prepareGgufMetadataRewrite: vi.fn<FileExplorerModelAccess['prepareGgufMetadataRewrite']>(),
};

const file = new Blob(['example']);
const fixture: ModelWeightDetails = {
  format: 'gguf',
  version: 3,
  alignment: 32,
  dataOffset: 64,
  metadata: [
    {
      key: 'general.name',
      type: 'string',
      value: 'Fixture model',
      count: undefined,
      elementType: undefined,
      range: undefined,
    },
    {
      key: 'tokenizer.chat_template',
      type: 'string',
      value: undefined,
      count: undefined,
      elementType: undefined,
      range: { offset: 20, length: 30 },
    },
  ],
  tensors: [{
    name: 'blk.0.ffn_up.weight',
    shape: [64, 128],
    originalShape: undefined,
    dtype: 'Q8_0',
    dtypeCode: 8,
    offset: 64,
    byteLength: 512,
  }],
  split: undefined,
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  access.inspectModelOverview.mockReset();
  access.inspectModel.mockReset().mockResolvedValue({
    status: 'weights',
    value: fixture,
  });
  access.readModelMetadataValue.mockReset().mockResolvedValue({
    values: ['{{ message.content }}'],
    next: undefined,
  });
  access.prepareGgufMetadataRewrite.mockReset();
});

describe('FileExplorerModelView', () => {
  it('cancels a compact detail request and returns to the overview when the file changes', async () => {
    access.inspectModelOverview.mockImplementation(async ({ file: snapshot }) => ({
      status: 'weights',
      value: {
        format: 'gguf',
        version: 3,
        split: undefined,
        name: snapshot === file ? 'First model' : 'Second model',
        metadataCount: 2,
        tensorCount: 1,
      },
    }));
    const pending = Promise.withResolvers<Awaited<ReturnType<FileExplorerModelAccess['inspectModel']>>>();
    access.inspectModel.mockReturnValueOnce(pending.promise);
    const wrapper = mount(FileExplorerModelView, { props: { file, access, canSave: false, compact: true } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="model-overview"]').text()).toContain('First model');
    expect(access.inspectModel).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="model-tensors-tab"]').trigger('click');
    const request = access.inspectModel.mock.calls[0]?.[0];
    expect(request?.signal?.aborted).toBe(false);

    await wrapper.setProps({ file: new Blob(['another model']) });
    pending.resolve({ status: 'weights', value: fixture });
    await flushPromises();
    expect(request?.signal?.aborted).toBe(true);
    expect(wrapper.get('[data-testid="model-overview"]').text()).toContain('Second model');
    expect(access.inspectModel).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="model-metadata-tab"]').trigger('click');
    expect(access.inspectModel).toHaveBeenCalledTimes(2);
  });

  it('loads a template value only when requested and ignores a stale read after selecting a different key', async () => {
    let complete: (() => void) | undefined;
    access.readModelMetadataValue.mockImplementationOnce(() => new Promise(resolve => {
      complete = () => resolve({ values: ['stale template'], next: undefined });
    }));
    const wrapper = mount(FileExplorerModelView, { props: { file, access, canSave: true } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="model-overview"]').text()).toContain('Fixture model');
    expect(access.inspectModel).toHaveBeenCalledWith(expect.objectContaining({ file }));
    expect(access.readModelMetadataValue).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="model-tokenizer-tab"]').trigger('click');
    expect(access.readModelMetadataValue).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="model-metadata-key"]').trigger('click');
    const requested = access.readModelMetadataValue.mock.calls[0]?.[0];
    expect(requested?.entry.key).toBe('tokenizer.chat_template');
    expect(requested?.limit).toBe(1);
    expect(requested?.signal?.aborted).toBe(false);

    await wrapper.get('[data-testid="model-metadata-tab"]').trigger('click');
    await wrapper.get('[data-testid="model-metadata-search"]').setValue('general.name');
    await wrapper.get('[data-testid="model-metadata-key"]').trigger('click');
    expect(requested?.signal?.aborted).toBe(true);
    complete?.();
    await flushPromises();
    expect(wrapper.get('[data-testid="model-metadata-scalar"]').text()).toBe('Fixture model');
  });

  it('keeps metadata edits after failed preparation and clears them only after a confirmed save', async () => {
    const plan = { header: new Uint8Array([1, 2, 3]), bodyOffset: 64 };
    access.prepareGgufMetadataRewrite.mockRejectedValueOnce(new Error('Unable to rewrite header')).mockResolvedValueOnce(plan);
    const wrapper = mount(FileExplorerModelView, { props: { file, access, canSave: true } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="model-metadata-tab"]').trigger('click');
    await wrapper.get('[data-testid="model-metadata-search"]').setValue('general.name');
    await wrapper.get('[data-testid="model-metadata-key"]').trigger('click');
    await wrapper.get('[data-testid="model-metadata-edit"]').trigger('click');
    await wrapper.get('[data-testid="model-metadata-input"]').setValue('New name');
    expect(wrapper.emitted('dirtyChange')).toEqual([[{ dirty: true }]]);

    await wrapper.get('[data-testid="model-metadata-save"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Unable to rewrite header');
    expect(wrapper.get<HTMLInputElement>('[data-testid="model-metadata-input"]').element.value).toBe('New name');
    expect(wrapper.emitted('save')).toBeUndefined();

    await wrapper.get('[data-testid="model-metadata-save"]').trigger('click');
    await flushPromises();
    expect(access.prepareGgufMetadataRewrite).toHaveBeenLastCalledWith(expect.objectContaining({
      file,
      changes: { 'general.name': 'New name' },
    }));
    expect(wrapper.emitted('save')).toEqual([[plan]]);
    expect(wrapper.emitted('dirtyChange')).toEqual([[{ dirty: true }]]);
    wrapper.vm.markSaved();
    expect(wrapper.emitted('dirtyChange')).toEqual([[{ dirty: true }], [{ dirty: false }]]);
  });

  it('filters tensors by full name even while their groups are collapsed', async () => {
    const wrapper = mount(FileExplorerModelView, { props: { file, access, canSave: false } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="model-tensors-tab"]').trigger('click');
    expect(wrapper.get('[data-testid="model-tensor-group"]').text()).toContain('blk');
    expect(wrapper.find('[data-testid="model-tensor-row"]').exists()).toBe(false);
    await wrapper.get('[data-testid="model-tensor-search"]').setValue('blk.0.ffn');
    const tensor = wrapper.get('[data-testid="model-tensor-row"]');
    expect(tensor.text()).toContain('blk.0.ffn_up.weight');
    expect(tensor.text()).toContain('[64, 128]');
    expect(tensor.text()).toContain('Q8_0 (#8)');
  });

  it('shows Safetensors metadata without exposing the GGUF editor', async () => {
    access.inspectModel.mockResolvedValueOnce({
      status: 'weights',
      value: { ...fixture, format: 'safetensors', version: undefined, alignment: undefined },
    });
    const wrapper = mount(FileExplorerModelView, { props: { file, access, canSave: true } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="model-overview"]').text()).toContain('Safetensors');
    expect(wrapper.find('[data-testid="model-tokenizer-tab"]').exists()).toBe(false);
    await wrapper.get('[data-testid="model-metadata-tab"]').trigger('click');
    await wrapper.get('[data-testid="model-metadata-key"]').trigger('click');
    expect(wrapper.get('[data-testid="model-metadata-scalar"]').text()).toBe('Fixture model');
    expect(wrapper.find('[data-testid="model-metadata-edit"]').exists()).toBe(false);
  });
});
