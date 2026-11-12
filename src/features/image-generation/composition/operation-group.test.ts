import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageGenerationOperationGroup from '@/features/image-generation/components/ImageGenerationOperationGroup.vue';
import ImageGenerationOperationActions from '@/features/image-generation/components/ImageGenerationOperationActions.vue';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), capture: vi.fn(), archive: vi.fn(), download: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { captureImageGenerationResults: mocks.capture } }));
vi.mock('../session/export', () => ({ createImageGenerationResultsArchive: mocks.archive }));
vi.mock('@/utils/stream-download', () => ({ downloadReadableStream: mocks.download }));

const operation = {
  id: toImageGenerationOperationId({ raw: 'operation-aa' }),
  sessionId: toImageGenerationSessionId({ raw: 'session-aa' }),
  createdAt: 1,
  runIds: [toImageGenerationRunId({ raw: 'run-aa' }), toImageGenerationRunId({ raw: 'run-bb' })],
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(true);
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

it('starts expanded and keeps the chosen collapse state when the same operation receives new result metadata', async () => {
  const wrapper = mount(ImageGenerationOperationGroup, { props: { operation }, slots: { default: '<button data-testid="result-control">Result</button>' } });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const toggle = wrapper.get('[data-testid="operation-toggle"]');
  const body = wrapper.get(`[id="${toggle.attributes('aria-controls')}"]`);
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(body.attributes('aria-hidden')).toBe('false');
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect(body.attributes('aria-hidden')).toBe('true');
  expect(body.attributes('inert')).toBeDefined();
  await wrapper.setProps({ operation: { ...operation, runIds: [...operation.runIds, toImageGenerationRunId({ raw: 'run-cc' })] } });
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect(toggle.text()).toContain('3');
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(body.attributes('inert')).toBeUndefined();
});

it('keeps the completed-results ZIP action usable outside the collapsed result body', async () => {
  const wrapper = mount(ImageGenerationOperationGroup, {
    props: { operation },
    slots: {
      actions: () => h(ImageGenerationOperationActions, {
        operation,
        store: { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'store-aa' }) },
        unfinished: true,
        savedImageCount: 1,
        downloadDisabled: false,
        recoveryDisabled: true,
      }),
      default: '<p>Generated images</p>',
    },
  });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="operation-toggle"]').trigger('click');
  const download = wrapper.get('[data-testid="operation-results-zip"]');
  expect(download.element.closest('[inert]')).toBeNull();
  expect(download.attributes('disabled')).toBeUndefined();
  await download.trigger('click');
  await flushPromises();
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(mocks.archive).toHaveBeenCalledOnce();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="operation-toggle"]').attributes('aria-expanded')).toBe('false');
});

it('keeps a run without a published operation visible without an empty operation heading', () => {
  const wrapper = mount(ImageGenerationOperationGroup, { props: { operation: undefined }, slots: { default: '<p data-testid="unaccepted-run">Queued request</p>' } });
  using _wrapper = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.find('[data-testid="operation-toggle"]').exists()).toBe(false);
  expect(wrapper.get('[aria-hidden]').attributes('aria-hidden')).toBe('false');
  expect(wrapper.get('[data-testid="unaccepted-run"]').text()).toBe('Queued request');
});
