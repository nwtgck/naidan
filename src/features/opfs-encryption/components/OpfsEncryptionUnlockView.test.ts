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
    unlockWithRecoveryKey: vi.fn(async () => {}),
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
      keySlots: [],
      activeEncryptedStoreId: 'encrypted-store',
    },
  };
}


beforeEach(async () => {
  await Promise.all([
    ensureStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase(),
    ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks(),
    ensureStrings.opfsEncryption__raw_opfs_access_disabled_during_transition(),
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

  it('does not expose the raw OPFS explorer while a transition is active', () => {
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
          keySlots: [],
          operation,
        },
        operation,
      },
    });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    expect(wrapper.text()).toContain(
      'Raw OPFS access is disabled until the interrupted transition has finished.',
    );
    expect(wrapper.text()).not.toContain('Open raw OPFS explorer');
  });
});
