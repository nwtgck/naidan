import { beforeEach, expect, it, vi } from 'vitest';
import { computed, ref, shallowRef } from 'vue';
import { mount } from '@vue/test-utils';
import type { ChatLocalModelOperation, ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { LocalModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useLocalModelLaunchChat';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatModelPreparation from './ChatModelPreparation.vue';

const queue = vi.hoisted(() => ({ cancel: vi.fn(), position: vi.fn(() => undefined) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({ getDownloadQueue: () => queue }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('uses the existing download presentation outside the picker with retry, pause and a way to choose again', async () => {
  const operation = shallowRef<ChatLocalModelOperation>({ id: 1, phase: 'downloading', candidates: [], model: undefined, error: undefined, downloadJobId: 1 });
  const job = shallowRef<DownloadJob>({ id: 1, key: 'download', repository: 'owner/Model-9B', source: 'repository', destination: { kind: 'opfs' }, status: 'downloading', selection: undefined, progress: undefined, error: undefined });
  const selection = {
    operation: computed(() => operation.value),
    downloadJob: computed(() => job.value),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    maySend: computed(() => false),
    accept: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  const wrapper = mount(ChatModelPreparation, { props: { selection, localState: undefined } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Model-9B');
  expect(wrapper.find('[data-testid="chat-local-model-input"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="browser-model-preparation"]').exists()).toBe(false);
  await wrapper.get('[data-testid="llama-download-pause"]').trigger('click');
  expect(queue.cancel).toHaveBeenCalledWith({ id: job.value.id });
  operation.value = { ...operation.value, phase: 'error', error: 'storage-error' };
  job.value = { ...job.value, status: 'failed', error: 'failed' };
  await wrapper.vm.$nextTick();
  await wrapper.get('[data-testid="llama-download-resume"]').trigger('click');
  expect(selection.retry).toHaveBeenCalledOnce();
  await wrapper.get('[data-testid="chat-model-prepare-choose"]').trigger('click');
  await wrapper.get('[data-testid="chat-model-prepare-cancel"]').trigger('click');
  expect(wrapper.emitted('choose-again')).toEqual([[]]);
  expect(wrapper.emitted('cancel')).toEqual([[]]);
});

it('reuses local loading progress and retry without the page-sized preparation presentation', async () => {
  const status = ref<'loading' | 'error'>('loading');
  const retry = vi.fn(async () => {});
  const localState = {
    visible: computed(() => true),
    model: computed(() => ({ modelId: 'user/Model-9B', size: 128, importedAt: 1 })),
    status: computed(() => status.value),
    error: computed(() => status.value === 'error' ? 'runtime-error' as const : undefined),
    progress: computed(() => undefined),
    homeOriginId: computed(() => undefined),
    maySend: computed(() => false),
    retry,
    back: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies LocalModelLaunchChatUi;
  const selection = {
    operation: computed(() => undefined),
    downloadJob: computed(() => undefined),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    maySend: computed(() => false),
    accept: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  const wrapper = mount(ChatModelPreparation, { props: { selection, localState } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get('[role="status"]').text()).toContain('Loading model');
  expect(wrapper.find('[data-testid="model-launch-loading"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="browser-model-preparation"]').exists()).toBe(false);
  status.value = 'error';
  await wrapper.vm.$nextTick();
  expect(wrapper.get('[role="alert"]').text()).toBeTruthy();
  await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
  expect(retry).toHaveBeenCalledOnce();
});
