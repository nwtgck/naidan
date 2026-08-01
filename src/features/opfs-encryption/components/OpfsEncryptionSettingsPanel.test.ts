import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY, type OpfsEncryptionInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { ensureStrings } from '@/strings';
import { prepareForOpfsEncryptionTransition } from '@/features/opfs-encryption/prepare-for-storage-transition';
import OpfsEncryptionSettingsPanel from './OpfsEncryptionSettingsPanel.vue';

const mockShowConfirm = vi.fn();
const mockBeginLocalOperation = vi.fn();
const mockFinishLocalOperation = vi.fn();
const mockUpdateProgress = vi.fn();

vi.mock('@/00-storage/service', () => ({
  storageService: {
    inspectOpfsEncryptionSettings: vi.fn(),
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
    updateProgress: mockUpdateProgress,
  }),
}));

vi.mock('@/features/opfs-encryption/prepare-for-storage-transition', () => ({
  prepareForOpfsEncryptionTransition: vi.fn(),
}));

function createEncryptedInspection(): Extract<OpfsEncryptionInspection, { type: 'encrypted' }> {
  return PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'encrypted-store' });
}


function getTeleportedElement(selector: string): DOMWrapper<HTMLElement> {
  const element = document.body.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Unable to find teleported element: ${selector}`);
  }
  return new DOMWrapper(element);
}

async function prepareVisibleStrings(): Promise<void> {
  await ensureStrings.opfsEncryption__opfs_encryption();
  await ensureStrings.opfsEncryption__select_opfs_as_active_storage_to_enable_encryption();
  await ensureStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase();
  await ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks();
  await ensureStrings.opfsEncryption__enter_passphrase_for_opfs_storage();
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
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('location', { reload: vi.fn() });
  vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue({ type: 'plain' });
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
      expect(storageService.inspectOpfsEncryptionSettings).not.toHaveBeenCalled();
    },
  );

  it('keeps transition controls disabled while storage requires a credential', async () => {
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue({
      access: 'locked',
      type: 'encrypted',
    });

    const wrapper = await mountPanel({ storageType: 'opfs' });

    expect(wrapper.text()).toContain('Enter the passphrase for this OPFS storage');
    expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="opfs-encryption-change-passphrase"]').exists()).toBe(false);
  });

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
      onProgress: mockUpdateProgress,
      passphrase,
      signal: undefined,
    });
    expect(mockBeginLocalOperation).toHaveBeenCalledOnce();
    expect(mockFinishLocalOperation).toHaveBeenCalledWith({
      outcome: 'settled_for_reload',
    });
    expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('aria-checked')).toBe('false');
    expect(storageService.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    expect(location.reload).not.toHaveBeenCalled();
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
        onProgress: mockUpdateProgress,
        passphrase,
        signal: undefined,
      });
      expect(mockFinishLocalOperation).toHaveBeenCalledWith({
        outcome: 'settled_for_reload',
      });
      expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('aria-checked')).toBe('false');
    },
  );

  it('does not inspect or recover in place after a started encryption transition fails', async () => {
    vi.mocked(storageService.inspectOpfsEncryptionSettings)
      .mockReset()
      .mockResolvedValue({ type: 'plain' });
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

    expect(mockFinishLocalOperation).toHaveBeenCalledWith({
      outcome: 'settled_for_reload',
    });
    expect(storageService.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Transferred settings do not match their source');
  });

  it('reports preparation failure in place without starting storage mutation', async () => {
    const failure = new Error('Unable to suspend local storage access');
    vi.mocked(prepareForOpfsEncryptionTransition).mockRejectedValueOnce(failure);
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase"]').setValue('q');
    await getTeleportedElement('[data-testid="opfs-encryption-passphrase-confirmation"]').setValue('q');
    await getTeleportedElement('[data-testid="opfs-encryption-experimental-accepted"]').setValue(true);

    await getTeleportedElement('[data-testid="opfs-encryption-enable"]').trigger('click');
    await flushPromises();

    expect(mockBeginLocalOperation).toHaveBeenCalledOnce();
    expect(mockFinishLocalOperation).toHaveBeenCalledWith({ outcome: 'preparation_failed' });
    expect(storageService.enableOpfsEncryption).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(failure.message);
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
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue(
      { access: 'unlocked', fileSystemId: createEncryptedInspection().mode.activeFileSystemId, type: 'encrypted' },
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
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue(
      { access: 'unlocked', fileSystemId: createEncryptedInspection().mode.activeFileSystemId, type: 'encrypted' },
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

  it('keeps the encrypted inspection unchanged until disable settlement reloads', async () => {
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue(
      { access: 'unlocked', fileSystemId: createEncryptedInspection().mode.activeFileSystemId, type: 'encrypted' },
    );
    vi.mocked(storageService.disableOpfsEncryption).mockResolvedValue(undefined);
    mockShowConfirm.mockResolvedValue(true);
    const wrapper = await mountPanel({ storageType: 'opfs' });
    const toggle = wrapper.get('[data-testid="opfs-encryption-toggle"]');
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect(toggle.attributes('disabled')).toBeUndefined();

    await toggle.trigger('click');
    await flushPromises();

    expect(storageService.disableOpfsEncryption).toHaveBeenCalledWith({
      onProgress: mockUpdateProgress,
      signal: undefined,
    });
    expect(mockFinishLocalOperation).toHaveBeenCalledWith({
      outcome: 'settled_for_reload',
    });
    expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('aria-checked')).toBe('true');
    expect(storageService.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('does not reopen or re-inspect storage after re-encryption settlement', async () => {
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue(
      { access: 'unlocked', fileSystemId: createEncryptedInspection().mode.activeFileSystemId, type: 'encrypted' },
    );
    vi.mocked(storageService.reencryptOpfsEncryption).mockResolvedValue(undefined);
    const wrapper = await mountPanel({ storageType: 'opfs' });
    await wrapper.get('[data-testid="opfs-encryption-reencrypt"]').trigger('click');
    const dialog = getTeleportedElement('[data-testid="opfs-encryption-reencrypt-dialog"]');
    expect(dialog.text()).toContain('every other key slot will be removed after re-encryption');
    await dialog.get('[data-testid="opfs-encryption-reencrypt-passphrase"]').setValue('current passphrase');
    await dialog.get('[data-testid="opfs-encryption-reencrypt-submit"]').trigger('click');
    await flushPromises();

    expect(storageService.reencryptOpfsEncryption).toHaveBeenCalledWith({
      onProgress: mockUpdateProgress,
      passphrase: 'current passphrase',
      signal: undefined,
    });
    expect(mockFinishLocalOperation).toHaveBeenCalledWith({
      outcome: 'settled_for_reload',
    });
    expect(wrapper.get('[data-testid="opfs-encryption-toggle"]').attributes('aria-checked')).toBe('true');
    expect(storageService.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('requires confirmation before decrypting and a current passphrase before re-encrypting storage', async () => {
    vi.mocked(storageService.inspectOpfsEncryptionSettings).mockResolvedValue(
      { access: 'unlocked', fileSystemId: createEncryptedInspection().mode.activeFileSystemId, type: 'encrypted' },
    );
    mockShowConfirm.mockResolvedValue(false);
    const wrapper = await mountPanel({ storageType: 'opfs' });

    await wrapper.get('[data-testid="opfs-encryption-toggle"]').trigger('click');
    await wrapper.get('[data-testid="opfs-encryption-reencrypt"]').trigger('click');
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-testid="opfs-encryption-reencrypt-dialog"]')).not.toBeNull();
    expect(storageService.disableOpfsEncryption).not.toHaveBeenCalled();
    expect(storageService.reencryptOpfsEncryption).not.toHaveBeenCalled();
    expect(prepareForOpfsEncryptionTransition).not.toHaveBeenCalled();
  });
});
