import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeveloperOpfsEncryptionInterruptionPanel from './DeveloperOpfsEncryptionInterruptionPanel.vue';
import { useConfirm } from '@/composables/useConfirm';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';

const mocks = vi.hoisted(() => ({
  inspectOpfsEncryption: vi.fn(),
  createInterruptedOpfsEncryptionForDebug: vi.fn(),
  createInterruptedOpfsDecryptionForDebug: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    inspectOpfsEncryption: mocks.inspectOpfsEncryption,
    createInterruptedOpfsEncryptionForDebug: mocks.createInterruptedOpfsEncryptionForDebug,
    createInterruptedOpfsDecryptionForDebug: mocks.createInterruptedOpfsDecryptionForDebug,
  },
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

describe('DeveloperOpfsEncryptionInterruptionPanel', () => {
  const showConfirm = vi.fn();
  const reload = vi.fn();

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    vi.stubGlobal('location', { reload });
    (useConfirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ showConfirm });
    showConfirm.mockResolvedValue(true);
    mocks.createInterruptedOpfsEncryptionForDebug.mockResolvedValue(undefined);
    mocks.createInterruptedOpfsDecryptionForDebug.mockResolvedValue(undefined);
  });

  it('creates a durable interrupted encryption state and reloads from plain OPFS', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryption).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-interrupted-encryption-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-interrupted-encryption-confirm-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-create-interrupted-encryption"]').trigger('click');
    await flushPromises();

    expect(mocks.createInterruptedOpfsEncryptionForDebug).toHaveBeenCalledWith({
      passphrase: 'developer passphrase',
      signal: undefined,
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows credential-required storage without exposing interruption actions', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue(
      PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
        firstSequence: 2,
        secondSequence: 1,
      }),
    );
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Enter the passphrase for this OPFS storage');
    });

    expect(wrapper.find('[data-testid="developer-create-interrupted-encryption"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="developer-create-interrupted-decryption"]').exists()).toBe(false);
  });

  it('creates a durable interrupted decryption state and reloads from encrypted OPFS', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({
      type: 'encrypted',
      state: {
        formatVersion: 1,
        sequence: 1,
        state: 'encrypted',
        keySlots: [],
        activeEncryptedStoreId: 'store-id',
      },
    });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="developer-create-interrupted-decryption"]').exists()).toBe(true);
    });

    await wrapper.get('[data-testid="developer-create-interrupted-decryption"]').trigger('click');
    await flushPromises();

    expect(mocks.createInterruptedOpfsDecryptionForDebug).toHaveBeenCalledWith({ signal: undefined });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('warns without trimming leading or trailing passphrase whitespace', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryption).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-interrupted-encryption-passphrase"]')
      .setValue(' developer passphrase ');
    await wrapper.get('[data-testid="developer-interrupted-encryption-confirm-passphrase"]')
      .setValue(' developer passphrase ');

    expect(wrapper.text()).toContain(
      'Leading or trailing whitespace is part of the passphrase and will not be removed.',
    );
    expect(wrapper.get('[data-testid="developer-create-interrupted-encryption"]').attributes('disabled'))
      .toBeUndefined();
  });

  it('rejects a line break in either passphrase field', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryption).toHaveBeenCalledOnce();
    });

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => `\
developer
passphrase`,
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    wrapper.get('[data-testid="developer-interrupted-encryption-confirm-passphrase"]')
      .element.dispatchEvent(pasteEvent);
    await flushPromises();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Passphrases cannot contain line breaks.');
    expect(wrapper.get('[data-testid="developer-create-interrupted-encryption"]').attributes('disabled'))
      .toBeDefined();
  });

  it('keeps the operation error visible after refreshing the inspection state', async () => {
    mocks.inspectOpfsEncryption.mockResolvedValue({ type: 'plain' });
    mocks.createInterruptedOpfsEncryptionForDebug.mockRejectedValue(new Error('debug interruption failed'));
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryption).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-interrupted-encryption-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-interrupted-encryption-confirm-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-create-interrupted-encryption"]').trigger('click');
    await flushPromises();

    expect(mocks.inspectOpfsEncryption).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('debug interruption failed');
    expect(reload).not.toHaveBeenCalled();
  });
});
