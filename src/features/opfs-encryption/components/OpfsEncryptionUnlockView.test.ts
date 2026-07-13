import { flushPromises, shallowMount } from '@vue/test-utils';
import { nextTick, shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';
import { ensureStrings } from '@/strings';
import type {
  OpfsEncryptionStartupGate,
  OpfsEncryptionStartupPhase,
} from '@/logic/startup/opfs-encryption-startup-gate';
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
  phase = 'locked',
  applicationError = undefined,
}: {
  inspection: Exclude<OpfsEncryptionInspection, { type: 'plain' }>,
  phase?: OpfsEncryptionStartupPhase,
  applicationError?: unknown,
}): OpfsEncryptionStartupGate {
  return {
    inspection: shallowRef(inspection),
    phase: shallowRef(phase),
    applicationError: shallowRef(applicationError),
    unlockWithPassphrase: vi.fn(async () => {}),
    retryInspection: vi.fn(async () => {}),
    reportApplicationFailure: vi.fn(),
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
      keySlots: [{
        id: 'slot-id',
        keyDerivation: {
          type: 'pbkdf2_hmac_sha256',
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      }],
      activeEncryptedStoreId: 'encrypted-store',
    },
  };
}


beforeEach(async () => {
  await ensureStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase();
  await ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks();
  await ensureStrings.opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery();
  await ensureStrings.opfsEncryption__resume_opfs_encryption();
  await ensureStrings.opfsEncryption__open_raw_opfs_explorer();
  await ensureStrings.opfsEncryption__naidan_could_not_finish_loading();
  await ensureStrings.opfsEncryption__preparing_naidan();
  await ensureStrings.opfsEncryption__storage_unlocked_preparing_application();
  await ensureStrings.opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading();
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
          keySlots: [{
            id: 'slot-id',
            keyDerivation: {
              type: 'pbkdf2_hmac_sha256',
              salt: 'salt',
              iterations: 10,
            },
            wrappedStorageUnlockKey: {
              nonce: 'nonce',
              ciphertext: 'ciphertext',
            },
          }],
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

  it('keeps the lock presentation while the unlocked application renders behind it', () => {
    const gate = createGate({
      inspection: createEncryptedInspection(),
      phase: 'preparing_application',
    });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    expect(wrapper.find('[data-testid="opfs-encryption-preparing-application"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Preparing Naidan');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('keeps recovery access visible when application preparation fails after unlock', async () => {
    const gate = createGate({
      inspection: createEncryptedInspection(),
      phase: 'application_failed',
      applicationError: new Error('chat bootstrap failed'),
    });
    const wrapper = shallowMount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    expect(wrapper.find('[data-testid="opfs-encryption-application-failed"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Naidan could not finish loading');
    expect(wrapper.text()).toContain('chat bootstrap failed');
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
