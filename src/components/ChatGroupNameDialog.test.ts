import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { toChatGroupId } from '@/01-models/ids';
import { useLayout } from '@/composables/useLayout';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatGroupNameDialog from './ChatGroupNameDialog.vue';

const mocks = vi.hoisted(() => ({ renameChatGroup: vi.fn(), isRenamingChatGroup: vi.fn(() => false) }));
vi.mock('@/composables/chat/ui/useChatGroupName', () => ({ useChatGroupName: () => mocks }));

function mountDialog({ rawId }: { rawId: string }) {
  const trigger = document.createElement('button');
  const host = document.createElement('div');
  document.body.append(trigger, host);
  trigger.focus();
  const wrapper = mount(ChatGroupNameDialog, {
    props: { chatGroup: { id: toChatGroupId({ raw: rawId }), name: 'Original name' }, restoreFocusTo: trigger },
    attachTo: host,
  });
  const element = document.querySelector<HTMLElement>('[data-testid="chat-group-name-dialog"]');
  if (!element) {
    throw new Error('Name dialog was not mounted');
  }
  const dialog = new DOMWrapper(element);
  return {
    wrapper,
    dialog,
    trigger,
    get input() {
      return dialog.get<HTMLInputElement>('[data-testid="chat-group-name-input"]');
    },
    [Symbol.dispose]() {
      if (wrapper.exists()) {
        wrapper.unmount();
      }
      host.remove();
      trigger.remove();
    },
  };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.renameChatGroup.mockReset().mockResolvedValue({ previousName: 'Original name', newName: 'New name' });
  mocks.isRenamingChatGroup.mockReturnValue(false);
  useLayout().setActiveFocusArea({ area: 'sidebar' });
});

describe('ChatGroupNameDialog', () => {
  it('selects the current name, traps keyboard focus and restores the trigger after closing', async () => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    const { wrapper, dialog, input, trigger } = fixture;
    expect(document.activeElement).toBe(input.element);
    expect(input.element.selectionStart).toBe(0);
    expect(input.element.selectionEnd).toBe('Original name'.length);
    expect(useLayout().activeFocusArea.value).toBe('dialog');
    await input.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(dialog.get('[data-testid="chat-group-name-cancel"]').element);
    await input.setValue('Changed name');
    dialog.get<HTMLButtonElement>('[data-testid="chat-group-name-save"]').element.focus();
    await dialog.get('[data-testid="chat-group-name-save"]').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);
    expect(useLayout().activeFocusArea.value).toBe('sidebar');
  });

  it('requires an actual nonempty change and does not save on blur', async () => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    const save = fixture.dialog.get('[data-testid="chat-group-name-save"]');
    expect(save.attributes('disabled')).toBeDefined();
    await fixture.input.setValue('   ');
    expect(save.attributes('disabled')).toBeDefined();
    await fixture.input.setValue(' New name ');
    await fixture.input.trigger('blur');
    expect(mocks.renameChatGroup).not.toHaveBeenCalled();
    expect(fixture.wrapper.emitted('close')).toBeUndefined();
    expect(save.attributes('disabled')).toBeUndefined();
  });

  it('saves a trimmed name once and prevents cancellation while saving', async () => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    const pending = Promise.withResolvers<{ previousName: string, newName: string }>();
    mocks.renameChatGroup.mockReturnValueOnce(pending.promise);
    await fixture.input.setValue('  New name  ');
    await fixture.input.trigger('keydown', { key: 'Enter' });
    await fixture.input.trigger('keydown', { key: 'Enter' });
    await fixture.input.trigger('blur');
    await fixture.input.trigger('keydown', { key: 'Escape' });
    expect(mocks.renameChatGroup).toHaveBeenCalledTimes(1);
    expect(mocks.renameChatGroup).toHaveBeenCalledWith({ chatGroup: { id: toChatGroupId({ raw: 'dialog-group' }), name: 'Original name' }, newName: 'New name', source: 'manual' });
    expect(fixture.wrapper.emitted('close')).toBeUndefined();
    expect(fixture.dialog.get('[data-testid="chat-group-name-save"]').attributes('disabled')).toBeDefined();
    pending.resolve({ previousName: 'Original name', newName: 'New name' });
    await flushPromises();
    expect(fixture.wrapper.emitted('close')).toHaveLength(1);
  });

  it.each(['Escape', 'button'] as const)('cancels with %s without saving the draft', async action => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    await fixture.input.setValue('Discarded name');
    switch (action) {
    case 'Escape':
      await fixture.input.trigger('keydown', { key: 'Escape' });
      break;
    case 'button':
      await fixture.dialog.get('[data-testid="chat-group-name-cancel"]').trigger('click');
      break;
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled cancellation action: ${_ex}`);
    }
    }
    expect(mocks.renameChatGroup).not.toHaveBeenCalled();
    expect(fixture.wrapper.emitted('close')).toHaveLength(1);
  });

  it('ignores Enter and Escape during IME composition, including composition-state fallback', async () => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    await fixture.input.setValue('Composed name');
    for (const key of ['Enter', 'Escape']) {
      await fixture.input.trigger('keydown', { key, isComposing: true });
      await fixture.input.trigger('keydown', { key, keyCode: 229 });
    }
    await fixture.input.trigger('compositionstart');
    await fixture.input.trigger('keydown', { key: 'Enter' });
    await fixture.input.trigger('keydown', { key: 'Escape' });
    expect(mocks.renameChatGroup).not.toHaveBeenCalled();
    expect(fixture.wrapper.emitted('close')).toBeUndefined();
    await fixture.input.trigger('compositionend');
    await fixture.input.trigger('keydown', { key: 'Escape' });
    expect(fixture.wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not let a late save from an unmounted dialog finish another rename', async () => {
    const pending = Promise.withResolvers<{ previousName: string, newName: string }>();
    mocks.renameChatGroup.mockReturnValueOnce(pending.promise);
    using first = mountDialog({ rawId: 'first-group' });
    await first.input.setValue('First name');
    await first.input.trigger('keydown', { key: 'Enter' });
    first.wrapper.unmount();

    using second = mountDialog({ rawId: 'second-group' });
    await second.input.setValue('Second name');
    pending.resolve({ previousName: 'Original name', newName: 'First name' });
    await flushPromises();
    expect(second.input.element.value).toBe('Second name');
    expect(second.wrapper.emitted('close')).toBeUndefined();
    await second.dialog.get('[data-testid="chat-group-name-save"]').trigger('click');
    await flushPromises();
    expect(mocks.renameChatGroup).toHaveBeenLastCalledWith({ chatGroup: { id: toChatGroupId({ raw: 'second-group' }), name: 'Original name' }, newName: 'Second name', source: 'manual' });
    expect(second.wrapper.emitted('close')).toHaveLength(1);
  });

  it('keeps the draft and offers a retry after a failed save', async () => {
    using fixture = mountDialog({ rawId: 'dialog-group' });
    mocks.renameChatGroup.mockRejectedValueOnce(new Error('Write failed'));
    await fixture.input.setValue('New name');
    await fixture.dialog.get('[data-testid="chat-group-name-save"]').trigger('click');
    await flushPromises();
    expect(fixture.input.element.value).toBe('New name');
    expect(fixture.dialog.get('[data-testid="chat-group-name-error"]').attributes('role')).toBe('alert');
    expect(fixture.wrapper.emitted('close')).toBeUndefined();
    await fixture.dialog.get('[data-testid="chat-group-name-save"]').trigger('click');
    await flushPromises();
    expect(mocks.renameChatGroup).toHaveBeenCalledTimes(2);
    expect(fixture.wrapper.emitted('close')).toHaveLength(1);
  });
});
