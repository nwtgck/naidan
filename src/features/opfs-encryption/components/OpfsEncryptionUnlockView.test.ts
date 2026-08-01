import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, shallowRef } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY, type OpfsEncryptionInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
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
    progress: shallowRef(undefined),
    unlockWithPassphrase: vi.fn(async () => {}),
    returnInterruptedEncryptionToPlain: vi.fn(async () => {}),
    retryInspection: vi.fn(async () => {}),
    reportApplicationFailure: vi.fn(),
    reportUnlockPresentationReady: vi.fn(),
    wait: vi.fn(async () => {}),
    waitForUnlockPresentation: vi.fn(async () => {}),
  };
}

function createCredentialRequiredInspection(): Extract<OpfsEncryptionInspection, { type: 'credential_required' }> {
  return PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
    firstSequence: 2,
    secondSequence: 1,
  });
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
  await ensureStrings.opfsEncryption__unlock_storage();
  await ensureStrings.opfsEncryption__unlocked();
  await ensureStrings.opfsEncryption__return_to_plain_before_authority_switch();
  await ensureStrings.opfsEncryption__return_to_plain_after_authority_switch();
  await ensureStrings.opfsEncryption__stop_encryption_and_return_to_plain();
  await ensureStrings.opfsEncryption__returning_to_plain_storage();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpfsEncryptionUnlockView', () => {
  it('waits for both authenticated unlock and the minimum still frame before seating', async () => {
    vi.useFakeTimers();
    const unlock = Promise.withResolvers<void>();
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    gate.unlockWithPassphrase = vi.fn(async () => await unlock.promise);
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('correct horse battery staple');
    await wrapper.get('form').trigger('submit');

    const button = wrapper.get('[data-testid="opfs-encryption-unlock-submit"]');
    expect(button.attributes('data-state')).toBe('retracting');
    expect(button.attributes('aria-label')).toBe('Unlock storage');

    await vi.advanceTimersByTimeAsync(880);
    expect(button.attributes('data-state')).toBe('retracting');

    unlock.resolve();
    await flushPromises();
    expect(button.attributes('data-state')).toBe('seating');
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(189);
    await flushPromises();
    expect(button.attributes('data-state')).toBe('seating');
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(button.attributes('data-state')).toBe('unlocked');
    expect(button.attributes('aria-label')).toBe('Unlocked');
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(gate.reportUnlockPresentationReady).toHaveBeenCalledOnce();
  });

  it('preserves success coordination while reducing motion duration', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('reduced motion passphrase');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const button = wrapper.get('[data-testid="opfs-encryption-unlock-submit"]');
    expect(button.attributes('data-state')).toBe('retracting');

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(button.attributes('data-state')).toBe('seating');

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(button.attributes('data-state')).toBe('unlocked');
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(gate.reportUnlockPresentationReady).toHaveBeenCalledOnce();
  });

  it('does not seat early when authentication finishes before the minimum still frame', async () => {
    vi.useFakeTimers();
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('fast passphrase');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const button = wrapper.get('[data-testid="opfs-encryption-unlock-submit"]');
    await vi.advanceTimersByTimeAsync(879);
    expect(button.attributes('data-state')).toBe('retracting');

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(button.attributes('data-state')).toBe('seating');
  });

  it('returns the mechanism to ready without showing success when unlock fails', async () => {
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    gate.unlockWithPassphrase = vi.fn(async () => {
      throw new Error('incorrect passphrase');
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('wrong passphrase');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[data-testid="opfs-encryption-unlock-submit"]')
      .attributes('data-state')).toBe('ready');
    expect(wrapper.text()).toContain('incorrect passphrase');
    expect(gate.reportUnlockPresentationReady).not.toHaveBeenCalled();
  });
  it('warns without trimming a passphrase with boundary whitespace', async () => {
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    const wrapper = mount(OpfsEncryptionUnlockView, {
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
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    const wrapper = mount(OpfsEncryptionUnlockView, {
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
    const gate = createGate({ inspection: createCredentialRequiredInspection() });
    const wrapper = mount(OpfsEncryptionUnlockView, {
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
    const gate = createGate({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
        operation: 'encrypt',
        phase: 'building_target',
        sourceFileSystemId: undefined,
        targetFileSystemId: 'target-store',
      }),
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
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


  it('requires the passphrase before returning a building encrypt operation to plain', async () => {
    const gate = createGate({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
        operation: 'encrypt',
        phase: 'building_target',
        sourceFileSystemId: undefined,
        targetFileSystemId: 'target-store',
      }),
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });
    const returnButton = wrapper.get('[data-testid="opfs-encryption-return-to-plain-button"]');

    expect(returnButton.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Enter the passphrase to authenticate the interrupted operation. Naidan will finish the protected transition state, then rebuild and verify plain storage before removing encryption.');
    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('existing passphrase');
    expect(returnButton.attributes('disabled')).toBeUndefined();

    await returnButton.trigger('click');
    await flushPromises();

    expect(gate.returnInterruptedEncryptionToPlain).toHaveBeenCalledWith({
      passphrase: 'existing passphrase',
    });
    expect(gate.reportUnlockPresentationReady).toHaveBeenCalledOnce();
  });

  it('requires the passphrase when encrypted storage is already authoritative', async () => {
    const gate = createGate({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
        operation: 'encrypt',
        phase: 'cleaning_up_source',
        sourceFileSystemId: undefined,
        targetFileSystemId: 'target-store',
      }),
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });
    const returnButton = wrapper.get('[data-testid="opfs-encryption-return-to-plain-button"]');

    expect(returnButton.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Encrypted storage is already authoritative. Enter the passphrase to rebuild and verify plain storage before removing encryption.');
    await wrapper.get('[data-testid="opfs-encryption-unlock-passphrase"]')
      .setValue('existing passphrase');
    expect(returnButton.attributes('disabled')).toBeUndefined();

    await returnButton.trigger('click');
    await flushPromises();

    expect(gate.returnInterruptedEncryptionToPlain).toHaveBeenCalledWith({
      passphrase: 'existing passphrase',
    });
  });

  it('keeps the lock presentation while the unlocked application renders behind it', () => {
    const gate = createGate({
      inspection: createCredentialRequiredInspection(),
      phase: 'preparing_application',
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
      props: { gate },
    });

    expect(wrapper.find('[data-testid="opfs-encryption-preparing-application"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Preparing Naidan');
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.get('[data-testid="opfs-encryption-unlock-submit"]')
      .attributes('data-state')).toBe('unlocked');
  });

  it('keeps recovery access visible when application preparation fails after unlock', async () => {
    const gate = createGate({
      inspection: createCredentialRequiredInspection(),
      phase: 'application_failed',
      applicationError: new Error('chat bootstrap failed'),
    });
    const wrapper = mount(OpfsEncryptionUnlockView, {
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
