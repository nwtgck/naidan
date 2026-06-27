import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { useConfirm } from '@/composables/useConfirm';
import { usePrompt } from '@/composables/usePrompt';
import GlobalDialogHost from './GlobalDialogHost.vue';

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

vi.mock('@/composables/usePrompt', () => ({
  usePrompt: vi.fn(),
}));

vi.mock('@/components/CustomDialog.vue', () => ({
  default: {
    props: [
      'show',
      'title',
      'message',
      'confirmButtonText',
      'cancelButtonText',
      'confirmButtonVariant',
      'showInput',
      'inputValue',
      'bodyComponent',
      'icon',
    ],
    emits: ['confirm', 'cancel', 'update:inputValue'],
    template: `\
<div v-if="show" data-testid="custom-dialog" :data-confirm-variant="confirmButtonVariant">
  <h3 data-testid="dialog-title">{{ title }}</h3>
  <p data-testid="dialog-message">{{ message }}</p>
  <input v-if="showInput" :value="inputValue" data-testid="dialog-input" />
  <button data-testid="dialog-cancel-button" @click="$emit('cancel')">{{ cancelButtonText }}</button>
  <button
    data-testid="dialog-confirm-button"
    :class="confirmButtonVariant === 'danger' ? 'bg-red-600' : ''"
    @click="$emit('confirm')"
  >{{ confirmButtonText }}</button>
</div>`,
  },
}));

describe('GlobalDialogHost', () => {
  const isConfirmOpen = ref(false);
  const confirmTitle = ref('');
  const confirmMessage = ref('');
  const confirmConfirmButtonText = ref('');
  const confirmCancelButtonText = ref('');
  const confirmButtonVariant = ref<'default' | 'danger'>('default');

  beforeEach(() => {
    isConfirmOpen.value = false;
    confirmTitle.value = '';
    confirmMessage.value = '';
    confirmConfirmButtonText.value = '';
    confirmCancelButtonText.value = '';
    confirmButtonVariant.value = 'default';

    (useConfirm as unknown as Mock).mockReturnValue({
      isConfirmOpen,
      confirmTitle,
      confirmMessage,
      confirmConfirmButtonText,
      confirmCancelButtonText,
      confirmButtonVariant,
      confirmIcon: ref(undefined),
      handleConfirm: vi.fn(),
      handleCancel: vi.fn(),
    });
    (usePrompt as unknown as Mock).mockReturnValue({
      isPromptOpen: ref(false),
      promptTitle: ref(''),
      promptMessage: ref(''),
      promptConfirmButtonText: ref(''),
      promptCancelButtonText: ref(''),
      promptInputValue: ref(''),
      promptBodyComponent: ref(undefined),
      handlePromptConfirm: vi.fn(),
      handlePromptCancel: vi.fn(),
    });
  });

  it('shows the danger confirm dialog while the normal application is not mounted', async () => {
    const wrapper = mount(GlobalDialogHost);
    await flushPromises();

    isConfirmOpen.value = true;
    confirmTitle.value = 'Confirm Reset';
    confirmMessage.value = 'Are you sure you want to reset data?';
    confirmConfirmButtonText.value = 'Reset';
    confirmCancelButtonText.value = 'Cancel';
    confirmButtonVariant.value = 'danger';
    await wrapper.vm.$nextTick();

    const confirmButton = wrapper.get('[data-testid="dialog-confirm-button"]');
    expect(confirmButton.text()).toBe('Reset');
    expect(confirmButton.classes()).toContain('bg-red-600');
  });
});
