import { shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as appBlockingTestOnly } from '@/composables/useAppBlockingOperation';
import { TEST_ONLY as overlayTestOnly } from '@/composables/useGlobalBlockingOverlay';
import {
  TEST_ONLY as transitionTestOnly,
  useOpfsEncryptionTransition,
} from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';
import { ensureStrings } from '@/strings';
import OpfsEncryptionTransitionView from './OpfsEncryptionTransitionView.vue';

beforeEach(async () => {
  await ensureStrings.opfsEncryption__updating_encrypted_storage();
  await ensureStrings.opfsEncryption__copying_and_verifying_complete_opfs_storage();
  await ensureStrings.opfsEncryption__source_remains_until_verified();
});

afterEach(() => {
  transitionTestOnly.reset();
  overlayTestOnly.reset();
  appBlockingTestOnly.activeOperations.clear();
  vi.clearAllMocks();
});

describe('OpfsEncryptionTransitionView', () => {
  it('distinguishes startup recovery from restarting an interrupted operation', () => {
    const transition = useOpfsEncryptionTransition();
    transition.beginLocalOperation();
    const wrapper = shallowMount(OpfsEncryptionTransitionView);

    expect(wrapper.text()).toContain('The original source remains available until the new storage has been completely verified.');
    expect(wrapper.text()).toContain('After an interruption, Naidan checks the storage state on the next startup and attempts recovery.');
    expect(wrapper.text()).toContain('If interrupted before switching to the new storage, you must start the operation again from the beginning to complete it.');
    expect(wrapper.text()).not.toContain('An interrupted operation resumes on the next startup.');
  });

  it('keeps the transition presentation in place after settlement until reload', () => {
    const transition = useOpfsEncryptionTransition();
    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'settled_for_reload',
    });
    const wrapper = shallowMount(OpfsEncryptionTransitionView);

    expect(wrapper.text()).toContain('Updating encrypted storage');
    expect(wrapper.find('[data-testid="opfs-encryption-transition-open-raw-opfs"]').exists()).toBe(false);
  });
});
