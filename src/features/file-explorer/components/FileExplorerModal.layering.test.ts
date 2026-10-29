import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerModal from './FileExplorerModal.vue';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function mountModal() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const wrapper = mount(FileExplorerModal, {
    attachTo: host,
    global: {
      stubs: {
        FileExplorer: {
          template: '<div tabindex="0" data-testid="file-explorer"><button data-testid="explorer-last-control">Last control</button></div>',
        },
        Teleport: true,
      },
    },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

describe('FileExplorerModal layering', () => {
  it('stays above modals that can launch File Explorer while remaining below global dialogs', () => {
    using view = mountModal();
    const { wrapper } = view;
    expect(wrapper.get('[data-testid="file-explorer-modal"]').classes()).toContain('z-[130]');
  });

  it('names the dialog and moves focus into the explorer', async () => {
    using view = mountModal();
    const { wrapper } = view;
    await nextTick();
    const panel = wrapper.get('[data-testid="file-explorer-modal-panel"]');
    expect(panel.attributes('role')).toBe('dialog');
    expect(panel.attributes('aria-modal')).toBe('true');
    expect(wrapper.get(`#${panel.attributes('aria-labelledby')}`).text()).toBe('File Explorer (OPFS)');
    expect(document.activeElement).toBe(wrapper.get('[data-testid="file-explorer"]').element);
  });

  it('keeps Tab navigation inside the dialog and stops keys reaching the underlying screen', async () => {
    using view = mountModal();
    const { wrapper } = view;
    const close = wrapper.get('[data-testid="file-explorer-modal-close"]');
    const last = wrapper.get('[data-testid="explorer-last-control"]');
    (last.element as HTMLElement).focus();
    await last.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(close.element);
    await close.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last.element);

    let leaked = false;
    const listener = () => {
      leaked = true;
    };
    document.addEventListener('keydown', listener);
    using cleanup = {
      [Symbol.dispose]() {
        document.removeEventListener('keydown', listener);
      },
    };
    await last.trigger('keydown', { key: 'Escape' });
    expect(leaked).toBe(false);
    void cleanup;
  });

  it('returns focus to a connected opener after closing', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    using cleanup = {
      [Symbol.dispose]() {
        opener.remove();
      },
    };
    opener.focus();
    {
      using view = mountModal();
      expect(document.activeElement).toBe(view.wrapper.get('[data-testid="file-explorer-modal-panel"]').element);
    }
    expect(document.activeElement).toBe(opener);
    void cleanup;
  });

  it('shows an archive initialization failure and keeps the close action available', async () => {
    const initialization = Promise.withResolvers<never>();
    const { openFileExplorer, closeFileExplorer, isFileExplorerOpen } = useFileExplorerModal();
    const host = document.createElement('div');
    document.body.appendChild(host);
    using cleanup = {
      [Symbol.dispose]() {
        closeFileExplorer();
        host.remove();
      },
    };
    openFileExplorer({
      options: {
        kind: 'archive-root',
        title: 'unsafe.zip',
        rootName: 'unsafe.zip',
        archive: { format: 'zip', source: { kind: 'blob', blob: new Blob([]) } },
      },
    });
    const wrapper = mount(FileExplorerModal, {
      attachTo: host,
      global: {
        stubs: {
          FileExplorer: defineComponent({
            async setup() {
              return await initialization.promise;
            },
            render() {
              return h('div');
            },
          }),
          Teleport: true,
        },
      },
    });
    using view = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };

    initialization.reject(new Error('ZIP contains too many indexed paths'));
    await flushPromises();

    const alert = wrapper.get('[data-testid="file-explorer-initialization-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe('Failed to load directory: ZIP contains too many indexed paths');
    expect(wrapper.get('[data-testid="file-explorer-modal-panel"]').text()).toContain('unsafe.zip');
    await wrapper.get('[data-testid="file-explorer-modal-close"]').trigger('click');
    expect(isFileExplorerOpen.value).toBe(false);
    void view;
    void cleanup;
  });
});
