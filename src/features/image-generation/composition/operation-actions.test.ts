import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageGenerationOperationActions from '@/features/image-generation/components/ImageGenerationOperationActions.vue';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), capture: vi.fn(), recover: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { captureImageGenerationResults: mocks.capture } }));
vi.mock('../session/operation-recovery', () => ({ recoverImageGenerationOperation: mocks.recover }));
const props = {
  store: { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) },
  operation: { id: toImageGenerationOperationId({ raw: 'operation-aa' }), sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), createdAt: 1, runIds: [toImageGenerationRunId({ raw: 'run-aa' })] },
  unfinished: true,
  disabled: false,
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
});

afterEach(() => vi.restoreAllMocks());

it('owns the action while awaiting confirmation, preventing duplicate downloads or recovery', async () => {
  const decision = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(decision.promise);
  const wrapper = mount(ImageGenerationOperationActions, { props });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await wrapper.get('[data-testid="operation-recover"]').trigger('click');
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
  decision.resolve(false);
  await flushPromises();
  expect(wrapper.get('[data-testid="operation-results-zip"]').attributes('disabled')).toBeUndefined();
});

it('does not start recovery after its confirmation view has been disposed', async () => {
  const decision = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(decision.promise);
  const wrapper = mount(ImageGenerationOperationActions, { props });
  await wrapper.get('[data-testid="operation-recover"]').trigger('click');
  await flushPromises();
  wrapper.unmount();
  decision.resolve(true);
  await flushPromises();
  expect(mocks.recover).not.toHaveBeenCalled();
});
