import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeveloperOpfsEncryptionInterruptionPanel from './DeveloperOpfsEncryptionInterruptionPanel.vue';
import { useConfirm } from '@/composables/useConfirm';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type {
  OpfsEncryptionTransitionProgressListener,
  OpfsEncryptionTransitionProgressOperation,
  OpfsEncryptionTransitionProgressPhase,
} from '@/00-storage/service/naidan-opfs/transition-progress';

const mocks = vi.hoisted(() => ({
  disableOpfsEncryption: vi.fn(),
  enableOpfsEncryption: vi.fn(),
  inspectOpfsEncryptionSettings: vi.fn(),
  reencryptOpfsEncryption: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    disableOpfsEncryption: mocks.disableOpfsEncryption,
    enableOpfsEncryption: mocks.enableOpfsEncryption,
    inspectOpfsEncryptionSettings: mocks.inspectOpfsEncryptionSettings,
    reencryptOpfsEncryption: mocks.reencryptOpfsEncryption,
  },
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

const unlockedFileSystemId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: 'developer-panel-file-system',
}).mode.activeFileSystemId;

function installExpectedInterruption({ method, operation, phase }: {
  method: ReturnType<typeof vi.fn>;
  operation: OpfsEncryptionTransitionProgressOperation;
  phase: OpfsEncryptionTransitionProgressPhase;
}): void {
  method.mockImplementation(async ({ onProgress, signal }: {
    onProgress: OpfsEncryptionTransitionProgressListener;
    signal: AbortSignal;
  }) => {
    onProgress({ progress: {
      completedBytes: 1,
      completedEntries: 1,
      operation,
      percent: undefined,
      phase,
      totalBytes: 1,
      totalEntries: 1,
    } });
    signal.throwIfAborted();
  });
}

describe('DeveloperOpfsEncryptionInterruptionPanel', () => {
  const showConfirm = vi.fn();
  const reload = vi.fn();

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    vi.stubGlobal('location', { reload });
    (useConfirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ showConfirm });
    showConfirm.mockResolvedValue(true);
  });

  it.each([
    { boundary: 'pre_switch', phase: 'verifying' },
    { boundary: 'post_switch', phase: 'cleaning_source' },
  ] as const)(
    'interrupts ordinary enable at $boundary without owning reload',
    async ({ boundary, phase }) => {
      mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ type: 'plain' });
      installExpectedInterruption({
        method: mocks.enableOpfsEncryption,
        operation: 'encrypting',
        phase,
      });
      const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
        props: { storageType: 'opfs' },
      });
      await vi.waitFor(() => {
        expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
      });

      await wrapper.get(`[data-testid="developer-opfs-interruption-boundary-${boundary.replace('_', '-')}"]`)
        .trigger('click');
      await wrapper.get('[data-testid="developer-opfs-interruption-passphrase"]')
        .setValue('developer passphrase');
      await wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
        .setValue('developer passphrase');
      await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
      await flushPromises();

      expect(mocks.enableOpfsEncryption).toHaveBeenCalledWith({
        onProgress: expect.any(Function),
        passphrase: 'developer passphrase',
        signal: expect.any(AbortSignal),
      });
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { boundary: 'pre_switch', phase: 'verifying' },
    { boundary: 'post_switch', phase: 'switching_authority' },
  ] as const)(
    'interrupts ordinary disable at $boundary without owning reload',
    async ({ boundary, phase }) => {
      mocks.inspectOpfsEncryptionSettings.mockResolvedValue({
        access: 'unlocked',
        fileSystemId: unlockedFileSystemId,
        type: 'encrypted',
      });
      installExpectedInterruption({
        method: mocks.disableOpfsEncryption,
        operation: 'decrypting',
        phase,
      });
      const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
        props: { storageType: 'opfs' },
      });
      await vi.waitFor(() => {
        expect(wrapper.get('[data-testid="developer-opfs-interruption-operation-disable"]')
          .attributes('aria-pressed')).toBe('true');
      });

      await wrapper.get(`[data-testid="developer-opfs-interruption-boundary-${boundary.replace('_', '-')}"]`)
        .trigger('click');
      await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
      await flushPromises();

      expect(mocks.disableOpfsEncryption).toHaveBeenCalledWith({
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      });
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { boundary: 'pre_switch', phase: 'verifying' },
    { boundary: 'post_switch', phase: 'cleaning_source' },
  ] as const)(
    'interrupts ordinary re-encryption at $boundary without owning reload',
    async ({ boundary, phase }) => {
      mocks.inspectOpfsEncryptionSettings.mockResolvedValue({
        access: 'unlocked',
        fileSystemId: unlockedFileSystemId,
        type: 'encrypted',
      });
      installExpectedInterruption({
        method: mocks.reencryptOpfsEncryption,
        operation: 'reencrypting',
        phase,
      });
      const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
        props: { storageType: 'opfs' },
      });
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="developer-opfs-interruption-operation-reencrypt"]')
          .exists()).toBe(true);
      });

      await wrapper.get('[data-testid="developer-opfs-interruption-operation-reencrypt"]')
        .trigger('click');
      await wrapper.get(`[data-testid="developer-opfs-interruption-boundary-${boundary.replace('_', '-')}"]`)
        .trigger('click');
      await wrapper.get('[data-testid="developer-opfs-interruption-passphrase"]')
        .setValue('retained passphrase');
      await wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
        .setValue('retained passphrase');
      await vi.waitFor(() => {
        expect(wrapper.get('[data-testid="developer-opfs-interruption-run"]').attributes('disabled'))
          .toBeUndefined();
      });
      await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
      await flushPromises();

      expect(mocks.reencryptOpfsEncryption).toHaveBeenCalledWith({
        onProgress: expect.any(Function),
        passphrase: 'retained passphrase',
        signal: expect.any(AbortSignal),
      });
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('does not expose transition actions for locked encrypted storage', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ access: 'locked', type: 'encrypted' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Enter the passphrase for this OPFS storage');
    });

    expect(wrapper.find('[data-testid="developer-opfs-interruption-run"]').exists()).toBe(false);
  });

  it('does not start a second confirmation while an operation request is pending', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({
      access: 'unlocked',
      fileSystemId: unlockedFileSystemId,
      type: 'encrypted',
    });
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    showConfirm.mockImplementationOnce(async () => await new Promise<boolean>(resolve => {
      settleConfirmation = resolve;
    }));
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="developer-opfs-interruption-operation-disable"]')
        .attributes('aria-pressed')).toBe('true');
    });

    await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
    await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');

    expect(showConfirm).toHaveBeenCalledOnce();
    expect(mocks.disableOpfsEncryption).not.toHaveBeenCalled();
    if (settleConfirmation === undefined) throw new Error('confirmation did not start');
    settleConfirmation(false);
    await flushPromises();
  });

  it('refreshes inspection when confirmation fails before a transition request starts', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ type: 'plain' });
    showConfirm.mockRejectedValueOnce(new Error('confirmation failed'));
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-opfs-interruption-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
    await flushPromises();

    expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledTimes(2);
    expect(mocks.enableOpfsEncryption).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('confirmation failed');
    expect(reload).not.toHaveBeenCalled();
  });

  it('warns without trimming leading or trailing passphrase whitespace', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ type: 'plain' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-opfs-interruption-passphrase"]')
      .setValue(' developer passphrase ');
    await wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
      .setValue(' developer passphrase ');

    expect(wrapper.text()).toContain(
      'Leading or trailing whitespace is part of the passphrase and will not be removed.',
    );
    expect(wrapper.get('[data-testid="developer-opfs-interruption-run"]').attributes('disabled'))
      .toBeUndefined();
  });

  it('rejects a line break in either passphrase field', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ type: 'plain' });
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    });

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => `\
developer
passphrase` },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
      .element.dispatchEvent(pasteEvent);
    await flushPromises();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Passphrases cannot contain line breaks.');
    expect(wrapper.get('[data-testid="developer-opfs-interruption-run"]').attributes('disabled'))
      .toBeDefined();
  });

  it('keeps an ordinary operation error visible without inspecting after the transition request', async () => {
    mocks.inspectOpfsEncryptionSettings.mockResolvedValue({ type: 'plain' });
    mocks.enableOpfsEncryption.mockRejectedValue(new Error('ordinary transition failed'));
    const wrapper = mount(DeveloperOpfsEncryptionInterruptionPanel, {
      props: { storageType: 'opfs' },
    });
    await vi.waitFor(() => {
      expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    });

    await wrapper.get('[data-testid="developer-opfs-interruption-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-opfs-interruption-confirm-passphrase"]')
      .setValue('developer passphrase');
    await wrapper.get('[data-testid="developer-opfs-interruption-run"]').trigger('click');
    await flushPromises();

    expect(mocks.inspectOpfsEncryptionSettings).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('ordinary transition failed');
    expect(reload).not.toHaveBeenCalled();
  });
});
