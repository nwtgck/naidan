import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import * as localInput from '@/features/llama-cpp-browser/logic/local-model-input';
import LlamaCppBrowserLocalFiles from './LlamaCppBrowserLocalFiles.vue';

type Accepted = { directories: Promise<ModelDirectoryInput[]>, save: 'browser' | 'later', controller: AbortController };

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function files({ paths }: { paths: string[] }): File[] {
  return paths.map(path => {
    const file = new File(['GGUF'], path.split('/').at(-1)!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  });
}

describe('shared local repository input', () => {
  it('reports synchronous drop capture failures through the accepted input promise', async () => {
    const error = new Error('File entry unavailable');
    using _capture = vi.spyOn(localInput, 'captureDroppedLocalModels').mockImplementation(() => {
      throw error;
    });
    const wrapper = mount(LlamaCppBrowserLocalFiles, { props: { disabled: false, layout: 'compact' } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { types: ['Files'], items: [] } });
    const accepted = wrapper.emitted<[Accepted]>('accept')![0]![0];
    await expect(accepted.directories).rejects.toBe(error);
  });

  it('uses one file input with an explicit save switch and captures its value for each accepted input', async () => {
    const wrapper = mount(LlamaCppBrowserLocalFiles, { props: { disabled: false, layout: 'compact' } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    expect(wrapper.findAll('input[type="file"]')).toHaveLength(2);
    const toggle = wrapper.get<HTMLInputElement>('[data-testid="local-model-save-in-browser"]');
    expect(toggle.element.checked).toBe(false);
    await toggle.setValue(true);
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: files({ paths: ['Model.gguf'] }) });
    await input.trigger('change');
    const accepted = wrapper.emitted<[Accepted]>('accept')![0]![0];
    expect(accepted).toMatchObject({ save: 'browser', repositoryLayout: 'confirmed' });
    await toggle.setValue(false);
    expect(accepted.save).toBe('browser');
    expect((await accepted.directories)[0]!.files.map(file => file.relativePath)).toEqual(['Model.gguf']);
    await input.trigger('change');
    expect(wrapper.emitted<[Accepted]>('accept')![1]![0].save).toBe('later');
  });

  it('confirms repository boundaries before registration and never pairs projectors across child repositories', async () => {
    const wrapper = mount(LlamaCppBrowserLocalFiles, { props: { disabled: false, layout: 'fill' } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-directory"]');
    Object.defineProperty(input.element, 'files', { value: files({ paths: ['Models/Text/Model.gguf', 'Models/Vision/Other.gguf', 'Models/Vision/mmproj.gguf'] }) });
    await input.trigger('change');
    const accepted = wrapper.emitted<[Accepted]>('accept')![0]![0];
    let resolved = false;
    void accepted.directories.then(() => {
      resolved = true;
    }, () => {});
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(resolved).toBe(false);
    expect(wrapper.find('[data-testid="local-model-repository-layout"]').exists()).toBe(true);
    // The owner can become busy after synchronous admission. Its pending
    // confirmation must remain usable even while other file actions are disabled.
    await wrapper.setProps({ disabled: true });
    await wrapper.get('[data-testid="local-model-layout-repositories"]').trigger('click');
    const directories = await accepted.directories;
    expect(directories.map(directory => ({ rootName: directory.rootName, paths: directory.files.map(file => file.relativePath) }))).toEqual([
      { rootName: 'Text', paths: ['Model.gguf'] }, { rootName: 'Vision', paths: ['Other.gguf', 'mmproj.gguf'] },
    ]);
    expect(wrapper.emitted('layout-pending')).toEqual([[true], [false]]);
  });

  it('cancels an unanswered layout when its input is disposed', async () => {
    const wrapper = mount(LlamaCppBrowserLocalFiles, { props: { disabled: false, layout: 'expanded' } });
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-directory"]');
    Object.defineProperty(input.element, 'files', { value: files({ paths: ['Repo/Q4/Model.gguf', 'Repo/Q8/Model.gguf'] }) });
    await input.trigger('change');
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.find('[data-testid="local-model-repository-layout"]').exists()).toBe(true);
    const accepted = wrapper.emitted<[Accepted]>('accept')![0]![0];
    const rejected = expect(accepted.directories).rejects.toMatchObject({ name: 'AbortError' });
    wrapper.unmount();
    await rejected;
    expect(accepted.controller.signal.aborted).toBe(true);
  });
});
