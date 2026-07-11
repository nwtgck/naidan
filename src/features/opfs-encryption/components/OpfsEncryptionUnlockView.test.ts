import { flushPromises, shallowMount } from '@vue/test-utils';
import { nextTick, shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';
import { ensureStrings } from '@/strings';
import type { OpfsEncryptionStartupGate } from '@/logic/startup/opfs-encryption-startup-gate';
import OpfsEncryptionUnlockView from './OpfsEncryptionUnlockView.vue';

const openFileExplorer = vi.hoisted(() => vi.fn());

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    isFileExplorerOpen: shallowRef(false),
    openFileExplorer,
  }),
}));

function createGate({
  inspection,
}: {
  inspection: Exclude<OpfsEncryptionInspection, { type: 'plain' }>,
}): OpfsEncryptionStartupGate {
  return {
    inspection: shallowRef(inspection),
    unlockWithPassphrase: vi.fn(async () => {}),
    retryInspection: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
  };
}

function createEncryptedInspection(): Extract<OpfsEncryptionInspection, { type: 'encrypted' }> {
  return {
    type: 'encrypted',
    state: {
      formatVersion: 1,
      sequence: 1,
      state: 'encrypted',
      passphraseKeySlot: {
        pbkdf2: {
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      },
      activeEncryptedStoreId: 'encrypted-store',
    },
  };
}


beforeEach(async () => {
  await Promise.all([
    ensureStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase(),
    ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks(),
    ensureStrings.opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery(),
    ensureStrings.opfsEncryption__resume_opfs_encryption(),
    ensureStrings.opfsEncryption__open_raw_opfs_explorer(),
  ]);
});

describe('OpfsEncryptionUnlockView', () => {
  it('warns without trimming a passphrase with boundary whitespace', async () => {
    const gate = createGate({ inspection: createEncryptedInspection() });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    await wrapper.find('input').setValue(' secret phrase ');
    expect(wrapper.text()).toContain(
      'Leading or trailing whitespace is part of the passphrase and will not be removed.',
    );

    await wrapper.find('form').trigger('submit');
    expect(gate.unlockWithPassphrase).toHaveBeenCalledWith({
      passphrase: ' secret phrase ',
    });
  });

  it('toggles passphrase visibility without changing its value', async () => {
    const gate = createGate({ inspection: createEncryptedInspection() });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });
    const input = wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]');
    await input.setValue('visible secret');

    expect(input.attributes('type')).toBe('password');
    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase-visibility"]').trigger('click');
    expect(input.attributes('type')).toBe('text');
    expect((input.element as HTMLInputElement).value).toBe('visible secret');
  });

  it('rejects line breaks before calling the unlock operation', async () => {
    const gate = createGate({ inspection: createEncryptedInspection() });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => `\
first line
second line`,
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    wrapper.find('input').element.dispatchEvent(pasteEvent);
    await nextTick();
    await flushPromises();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Passphrases cannot contain line breaks.');

    await wrapper.find('form').trigger('submit');
    expect(gate.unlockWithPassphrase).not.toHaveBeenCalled();
  });

  it('keeps the raw OPFS explorer available while warning during a transition', async () => {
    const operation = {
      type: 'encrypting' as const,
      phase: 'building_target' as const,
      targetEncryptedStoreId: 'target-store',
    };
    const gate = createGate({
      inspection: {
        type: 'transitioning',
        state: {
          formatVersion: 1,
          sequence: 1,
          state: 'transitioning',
          passphraseKeySlot: {
            pbkdf2: {
              salt: 'salt',
              iterations: 10,
            },
            wrappedStorageUnlockKey: {
              nonce: 'nonce',
              ciphertext: 'ciphertext',
            },
          },
          operation,
        },
        operation,
      },
    });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    expect(wrapper.text()).toContain('Resume OPFS encryption');
    expect(wrapper.text()).toContain(
      'Changing raw OPFS data while the interrupted operation is active can make recovery impossible. Back it up before making destructive changes.',
    );
    const button = wrapper.findAll('button').find(
      candidate => candidate.text().includes('Open raw OPFS explorer'),
    );
    if (button === undefined) {
      throw new Error('Expected raw OPFS explorer button');
    }
    await button.trigger('click');
    expect(openFileExplorer).toHaveBeenCalledWith({
      options: { kind: 'opfs-root' },
    });
  });
});
