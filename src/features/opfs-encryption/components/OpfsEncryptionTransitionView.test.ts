import { shallowMount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as appBlockingTestOnly } from '@/composables/useAppBlockingOperation';
import { TEST_ONLY as overlayTestOnly } from '@/composables/useGlobalBlockingOverlay';
import {
  TEST_ONLY as transitionTestOnly,
  useOpfsEncryptionTransition,
} from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';
import { ensureStrings } from '@/strings';
import OpfsEncryptionTransitionView from './OpfsEncryptionTransitionView.vue';

const openFileExplorer = vi.hoisted(() => vi.fn());

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    isFileExplorerOpen: shallowRef(false),
    openFileExplorer,
  }),
}));

beforeEach(async () => {
  await ensureStrings.opfsEncryption__encrypted_storage_needs_recovery();
  await ensureStrings.opfsEncryption__raw_opfs_access_does_not_decrypt();
  await ensureStrings.opfsEncryption__open_raw_opfs_explorer();
});

afterEach(() => {
  transitionTestOnly.reset();
  overlayTestOnly.reset();
  appBlockingTestOnly.activeOperations.clear();
  vi.clearAllMocks();
});

describe('OpfsEncryptionTransitionView', () => {
  it('keeps raw OPFS recovery access visible when local state is uncertain', async () => {
    const transition = useOpfsEncryptionTransition();
    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'recovery_required',
      errorMessage: 'Could not prove a stable OPFS backend',
    });
    const wrapper = shallowMount(OpfsEncryptionTransitionView);

    expect(wrapper.text()).toContain('Could not prove a stable OPFS backend');
    const button = wrapper.get('[data-testid="opfs-encryption-transition-open-raw-opfs"]');
    await button.trigger('click');

    expect(openFileExplorer).toHaveBeenCalledWith({
      options: { kind: 'opfs-root' },
    });
  });
});
