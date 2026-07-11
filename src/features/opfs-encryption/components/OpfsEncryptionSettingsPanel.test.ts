import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { ensureStrings } from '@/strings';
import { prepareForOpfsEncryptionTransition } from '@/features/opfs-encryption/prepare-for-storage-transition';
import OpfsEncryptionSettingsPanel from './OpfsEncryptionSettingsPanel.vue';

const mockShowConfirm = vi.fn();
const mockBeginLocalOperation = vi.fn();
const mockFinishLocalOperation = vi.fn();

vi.mock('@/00-storage/service', () => ({
  storageService: {
    inspectOpfsEncryption: vi.fn(),
    enableOpfsEncryption: vi.fn(),
    changeOpfsEncryptionPassphrase: vi.fn(),
    disableOpfsEncryption: vi.fn(),
    reencryptOpfsEncryption: vi.fn(),
  },
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

vi.mock('@/features/opfs-encryption/composables/useOpfsEncryptionTransition', () => ({
  useOpfsEncryptionTransition: () => ({
    beginLocalOperation: mockBeginLocalOperation,
    finishLocalOperation: mockFinishLocalOperation,
  }),
}));

vi.mock('@/features/opfs-encryption/prepare-for-storage-transition', () => ({
  prepareForOpfsEncryptionTransition: vi.fn(),
}));

function createEncryptedInspection() {
  return {
    type: 'encrypted' as const,
    state: {
      formatVersion: 1 as const,
      sequence: 0,
      state: 'encrypted' as const,
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
      activeEncryptedStoreId: 'store-id',
    },
  };
}


function getTeleportedElement(selector: string): DOMWrapper<HTMLElement> {
  const element = document.body.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Unable to find teleported element: ${selector}`);
  }
  return new DOMWrapper(element);
}

async function prepareVisibleStrings(): Promise<void> {
  await Promise.all([
    ensureStrings.opfsEncryption__opfs_encryption(),
    ensureStrings.opfsEncryption__select_opfs_as_active_storage_to_enable_encryption(),
    ensureStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase(),
    ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks(),
  ]);
}

async function mountPanel({
  storageType,
}: {
  storageType: 'local' | 'opfs' | 'memory',
}) {
  await prepareVisibleStrings();
  const wrapper = mount(OpfsEncryptionSettingsPanel, {
    attachTo: document.body,
    props: { storageType },
  });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storageService.inspectOpfsEncryption).mockResolvedValue({ type: 'plain' });
  vi.mocked(storageService.enableOpfsEncryption).mockResolvedValue(undefined);
  vi.mocked(prepareForOpfsEncryptionTransition).mockResolvedValue(undefined);
});

describe('OpfsEncryptionSettingsPanel', () => {
  it.each(['local', 'memory'] as const)(
    'remains visible and disabled for %s storage',
    async storageType => {
      const wrapper = await mountPanel({ storageType });

      expect(wrapper.text()).toContain('OPFS encryption');
      expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('disabled')).toBeDefined();
      expect(wrapper.text()).toContain('Select OPFS as the active storage provider');
      expect(storageService.inspectOpfsEncryption).not.toHaveBeenCalled();
    },
  );

  it('teleports the setup dialog and toggles passphrase visibility', async () => {
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');

    const dialog = getTeleportedElement('[data-testid="opfs-encryption-setup-dialog"]');
    expect(document.body.contains(dialog.element)).toBe(true);
    expect(wrapper.element.contains(dialog.element)).toBe(false);

    const passphraseInput = getTeleportedElement('[data-testid="opfs-encryption-passphrase"]');
    const confirmationInput = getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation"]');
    expect(passphraseInput.attributes('type')).toBe('password');
    expect(confirmationInput.attributes('type')).toBe('password');

    await getTeleportedElement('[data-testid="opfs-encryption-passphrase-visibility"]').trigger('click');
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation-visibility"]').trigger('click');

    expect(passphraseInput.attributes('type')).toBe('text');
    expect(confirmationInput.attributes('type')).toBe('text');
  });

  it('preserves boundary whitespace when enabling encryption and shows a warning', async () => {
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');

    const passphrase = ' exact passphrase ';
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase"]').setValue(passphrase);
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation"]').setValue(passphrase);
    await getTeleportedElement('[data-testid="opfs-encryption-experimental-accepted"]').setValue(true);

    expect(document.body.textContent).toContain(
      'Leading or trailing whitespace is part of the passphrase and will not be removed.',
    );
    await getTeleportedElement('[data-testid="opfs-encryption-enable"]').trigger('click');
    await flushPromises();

    expect(prepareForOpfsEncryptionTransition).toHaveBeenCalledOnce();
    expect(storageService.enableOpfsEncryption).toHaveBeenCalledWith({
      passphrase,
      signal: undefined,
    });
    expect(mockBeginLocalOperation).toHaveBeenCalledOnce();
    expect(mockFinishLocalOperation).toHaveBeenCalledWith({ success: true });
  });

  it.each(['q', '1'])(
    'enables encryption with the single-character passphrase %s',
    async passphrase => {
      const wrapper = await mountPanel({ storageType: 'opfs' });
      await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
      await getTeleportedElement('[data-testid="opfs-encryption-passphrase"]').setValue(passphrase);
      await getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation"]').setValue(passphrase);
      await getTeleportedElement('[data-testid="opfs-encryption-experimental-accepted"]').setValue(true);

      await getTeleportedElement('[data-testid="opfs-encryption-enable"]').trigger('click');
      await flushPromises();

      expect(storageService.enableOpfsEncryption).toHaveBeenCalledWith({
        passphrase,
        signal: undefined,
      });
      expect(mockFinishLocalOperation).toHaveBeenCalledWith({ success: true });
    },
  );

  it('refreshes the stable inspection after an encryption transition fails', async () => {
    vi.mocked(storageService.enableOpfsEncryption).mockRejectedValueOnce(
      new Error('Transferred settings do not match their source'),
    );
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase"]').setValue('q');
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation"]').setValue('q');
    await getTeleportedElement('[data-testid="opfs-encryption-experimental-accepted"]').setValue(true);

    await getTeleportedElement('[data-testid="opfs-encryption-enable"]').trigger('click');
    await flushPromises();

    expect(mockFinishLocalOperation).toHaveBeenCalledWith({ success: false });
    expect(storageService.inspectOpfsEncryption).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      'Transferred settings do not match their source',
    );
  });

  it('rejects pasted line breaks rather than silently changing the passphrase', async () => {
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
    const input = getTeleportedElement('[data-testid="opfs-encryption-passphrase"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: () => `\
line one
line two`,
      },
    });

    input.element.dispatchEvent(event);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain('Passphrases cannot contain line breaks.');
    expect(storageService.enableOpfsEncryption).not.toHaveBeenCalled();
  });

  it('changes the passphrase without starting a storage transition', async () => {
    vi.mocked(storageService.inspectOpfsEncryption).mockResolvedValue(
      createEncryptedInspection(),
    );
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-change-passphrase"]').trigger('click');

    const passphrase = ' new exact passphrase ';
    await getTeleportedElement('[data-testid="opfs-encryption-new-passphrase"]').setValue(passphrase);
    await getTeleportedElement('[data-testid="opfs-encryption-new-passphrase-confirmation"]').setValue(passphrase);
    await getTeleportedElement('[data-testid="opfs-encryption-change-passphrase-submit"]').trigger('click');
    await flushPromises();

    expect(storageService.changeOpfsEncryptionPassphrase).toHaveBeenCalledWith({
      passphrase,
    });
    expect(prepareForOpfsEncryptionTransition).not.toHaveBeenCalled();
    expect(mockBeginLocalOperation).not.toHaveBeenCalled();
  });

  it('toggles visibility for a changed passphrase', async () => {
    vi.mocked(storageService.inspectOpfsEncryption).mockResolvedValue(
      createEncryptedInspection(),
    );
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-change-passphrase"]').trigger('click');

    const passphraseInput = getTeleportedElement('[data-testid="opfs-encryption-new-passphrase"]');
    const confirmationInput = getTeleportedElement('[data-testid="opfs-encryption-new-passphrase-confirmation"]');
    expect(passphraseInput.attributes('type')).toBe('password');
    expect(confirmationInput.attributes('type')).toBe('password');

    await getTeleportedElement('[data-testid="opfs-encryption-new-passphrase-visibility"]').trigger('click');
    await getTeleportedElement('[data-testid="opfs-encryption-new-passphrase-confirmation-visibility"]').trigger('click');

    expect(passphraseInput.attributes('type')).toBe('text');
    expect(confirmationInput.attributes('type')).toBe('text');
  });

  it('requires confirmation before decrypting or re-encrypting storage', async () => {
    vi.mocked(storageService.inspectOpfsEncryption).mockResolvedValue(
      createEncryptedInspection(),
    );
    mockShowConfirm.mockResolvedValue(false);
    const wrapper = await mountPanel({ storageType: 'opfs' });

    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
    await wrapper.get('[data-testid="opfs-encryption-reencrypt"]').trigger('click');
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
    expect(storageService.disableOpfsEncryption).not.toHaveBeenCalled();
    expect(storageService.reencryptOpfsEncryption).not.toHaveBeenCalled();
    expect(prepareForOpfsEncryptionTransition).not.toHaveBeenCalled();
  });
});
