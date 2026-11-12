import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageGenerationOperationActions from '@/features/image-generation/components/ImageGenerationOperationActions.vue';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), capture: vi.fn(), recover: vi.fn(), archive: vi.fn(), download: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { captureImageGenerationResults: mocks.capture } }));
vi.mock('../session/operation-recovery', () => ({ recoverImageGenerationOperation: mocks.recover }));
vi.mock('../session/export', () => ({ createImageGenerationResultsArchive: mocks.archive }));
vi.mock('@/utils/stream-download', () => ({ downloadReadableStream: mocks.download }));
const props = {
  store: { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) },
  operation: { id: toImageGenerationOperationId({ raw: 'operation-aa' }), sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), createdAt: 1, runIds: [toImageGenerationRunId({ raw: 'run-aa' })] },
  unfinished: true,
  savedImageCount: 1,
  downloadDisabled: false,
  recoveryDisabled: false,
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue({ manifest: new Blob(['{}']), images: [{ path: 'images/001/01.png', blob: new Blob(['image']) }] });
  mocks.archive.mockReturnValue({
    stream: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    completed: Promise.resolve(),
  });
  mocks.download.mockResolvedValue(undefined);
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

it('saves completed images during an unfinished operation while recovery remains blocked', async () => {
  mocks.confirm.mockResolvedValue(true);
  const wrapper = mount(ImageGenerationOperationActions, { props: { ...props, recoveryDisabled: true } });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get('[data-testid="operation-recover"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="operation-results-zip"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  expect(mocks.capture).toHaveBeenCalledExactlyOnceWith({ store: props.store, sessionId: props.operation.sessionId, operationId: props.operation.id });
  expect(mocks.archive).toHaveBeenCalledOnce();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(mocks.recover).not.toHaveBeenCalled();
});

it('keeps zero-image operations visible but does not offer an empty result ZIP', async () => {
  const wrapper = mount(ImageGenerationOperationActions, { props: { ...props, savedImageCount: 0 } });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const download = wrapper.get('[data-testid="operation-results-zip"]');
  expect(download.attributes('disabled')).toBeDefined();
  expect(wrapper.get('[role="status"]').text()).toBe('No completed images to save yet.');
  await download.trigger('click');
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.capture).not.toHaveBeenCalled();
});

it('rechecks the captured results after confirmation rather than saving a ZIP whose images were deleted', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.capture.mockResolvedValue({ manifest: new Blob(['{}']), images: [] });
  const wrapper = mount(ImageGenerationOperationActions, { props });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(wrapper.emitted('updated')).toHaveLength(1);
  expect(wrapper.get('[role="alert"]').text()).toBe('No completed images to save yet.');
});

it('rechecks deletion availability after confirmation before capturing results', async () => {
  const decision = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(decision.promise);
  const wrapper = mount(ImageGenerationOperationActions, { props });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  await wrapper.setProps({ downloadDisabled: true });
  decision.resolve(true);
  await flushPromises();
  expect(mocks.capture).not.toHaveBeenCalled();
});

it('does not capture or download results after its confirmation view has been disposed', async () => {
  const decision = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValue(decision.promise);
  const wrapper = mount(ImageGenerationOperationActions, { props });
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  wrapper.unmount();
  decision.resolve(true);
  await flushPromises();
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it('shows the captured ZIP count while later generated images become available for the next download', async () => {
  const saving = Promise.withResolvers<void>();
  mocks.confirm.mockResolvedValue(true);
  mocks.download.mockReturnValue(saving.promise);
  const wrapper = mount(ImageGenerationOperationActions, { props });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="operation-results-zip"]').trigger('click');
  await flushPromises();
  await wrapper.setProps({ savedImageCount: 2 });
  expect(wrapper.get('[data-testid="operation-results-zip-count"]').text()).toBe('1');
  saving.resolve();
  await flushPromises();
  expect(wrapper.get('[data-testid="operation-results-zip-count"]').text()).toBe('2');
});
