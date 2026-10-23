import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { toChatId, toMessageId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type Chat, type Settings } from '@/01-models/types';
import type { ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { LocalModel, ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { applyScopedSettingChangesToChat } from '@/logic/scoped-setting-changes';

const mocks = vi.hoisted(() => ({
  chat: undefined as Ref<Chat | null> | undefined,
  settings: undefined as Ref<Settings> | undefined,
  apply: vi.fn(),
  applyChat: vi.fn(),
  importFiles: vi.fn(),
  source: vi.fn(),
  inspect: vi.fn(),
  register: vi.fn(),
  offer: vi.fn(),
  suspend: vi.fn(),
  installed: vi.fn(),
  enqueue: vi.fn(),
  pause: vi.fn(),
  storageCurrent: true,
  sourceCurrent: true,
}));
vi.mock('@/00-storage/service', () => ({ storageService: { captureSettingsStorage: () => () => mocks.storageCurrent } }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: mocks.settings }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ getLiveChatById: () => mocks.chat?.value ?? null, rootItems: { value: [] }, updateEmptyChatScopedSettings: mocks.apply, updateChatScopedSettings: mocks.applyChat }));
vi.mock('./chat-model-binding-operations', () => ({ withChatModelBindingFinalization: async ({ operation }: { operation(): Promise<unknown> }) => operation() }));
vi.mock('@/features/llama-cpp-browser/logic/local-model-input', () => ({ importLocalModelDirectories: mocks.importFiles }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ captureTemporaryModelSource: mocks.source }));
vi.mock('@/features/llama-cpp-browser/model-recovery/availability', () => ({ inspectLocalModel: mocks.inspect }));
vi.mock('@/features/llama-cpp-browser/composables/local-model-launch-session', () => ({ registerLocalModelLaunchSession: mocks.register }));
vi.mock('@/features/llama-cpp-browser/composables/useLocalModelLaunchChat', () => ({ suspendLocalModelLaunchPreparation: mocks.suspend }));
vi.mock('@/features/llama-cpp-browser/composables/useTemporaryModelSave', () => ({ offerTemporaryModelSave: mocks.offer }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: mocks.installed }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-plan', () => ({ selectionKey: () => 'target-key' }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({ getDownloadQueue: () => ({ jobs: { value: [] }, enqueue: mocks.enqueue, cancel: mocks.pause }) }));
import { useChatLocalModel } from './useChatLocalModel';
import { chatLocalModelInputs } from './chat-local-model-input';

const chatId = toChatId({ raw: 'existing' });
const model: LocalModel = { modelId: 'temp/local:Q4', size: 128, importedAt: 1 };
const second: LocalModel = { ...model, modelId: 'temp/local:Q8' };
const directory: ModelDirectoryInput = { rootName: 'local', files: [{ relativePath: 'model.gguf', file: new File(['GGUF'], 'model.gguf') }] };
const target: ModelLaunchTarget = { modelId: 'hf.co/owner/model:Q4', mainFilePath: 'Q4.gguf', selection: { repository: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'Q4.gguf', size: 128 }] } };
const scopes: ReturnType<typeof effectScope>[] = [];

function render({ binding }: { binding: 'empty-chat' | 'chat' }) {
  const scope = effectScope();
  scopes.push(scope);
  const selected = ref(chatId);
  const command = scope.run(() => useChatLocalModel({ chatId: selected, binding }))!;
  return { command, scope, selected };
}

function accept({ command }: { command: ReturnType<typeof useChatLocalModel> }) {
  return command.accept({ directories: Promise.resolve([directory]), controller: new AbortController() });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.storageCurrent = true;
  mocks.sourceCurrent = true;
  mocks.chat = ref({ id: chatId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false });
  mocks.settings = ref({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'openai', url: 'https://example.invalid' }, defaultModelId: 'remote' });
  mocks.importFiles.mockResolvedValue([model]);
  mocks.inspect.mockResolvedValue('available');
  mocks.source.mockImplementation(async () => ({ model, rootPath: 'temp/local', registrationRevision: 1, isCurrent: () => mocks.sourceCurrent }));
  mocks.apply.mockImplementation(async ({ changes, isCurrent }: { changes: readonly ScopedSettingChange[], isCurrent(): boolean }) => {
    if (!isCurrent() || mocks.chat!.value === null || mocks.chat!.value.root.items.length) {
      return false;
    }
    Object.assign(mocks.chat!.value, applyScopedSettingChangesToChat({ current: mocks.chat!.value, changes, updatedAt: 2 }));
    return true;
  });
});

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop();
  }
  chatLocalModelInputs.value = new Map();
});

it('applies an explicit selection to a chat with history without changing title settings or defaults', async () => {
  const chat = mocks.chat!.value!;
  chat.root.items.push({ id: toMessageId({ raw: 'kept-message' }), role: 'user', modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'Keep this message', completeness: 'complete' }], createdAt: 1, replies: { items: [] } });
  chat.titleGeneration = 'disabled';
  mocks.applyChat.mockImplementation(async ({ changes }: { changes: readonly ScopedSettingChange[] }) => {
    Object.assign(chat, applyScopedSettingChangesToChat({ current: chat, changes, updatedAt: 2 }));
  });
  const { command } = render({ binding: 'chat' });
  await command.useModel({ model });
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.applyChat).toHaveBeenCalledExactlyOnceWith({
    chatId,
    changes: [
      { field: 'endpoint', behavior: 'override', value: { type: 'llama_cpp_browser' } },
      { field: 'model_id', behavior: 'override', value: model.modelId },
    ],
    isCurrent: expect.any(Function),
  });
  expect(chat.root.items).toHaveLength(1);
  expect(chat.titleGeneration).toBe('disabled');
  expect(chat.modelId).toBe(model.modelId);
  expect(mocks.settings!.value.defaultModelId).toBe('remote');
  expect(mocks.offer).toHaveBeenCalledWith(expect.objectContaining({ chatId, chatGroupId: undefined }));
});

it('applies only scoped settings to the same chat and hands runtime preparation to the shared session', async () => {
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(mocks.chat!.value).toMatchObject({ id: chatId, modelId: model.modelId, endpoint: { type: 'llama_cpp_browser' }, titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
  expect(mocks.settings!.value.defaultModelId).toBe('remote');
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chat: mocks.chat!.value, model, homeOriginId: undefined }));
  expect(mocks.register.mock.calls[0]![0]).not.toHaveProperty('prepared');
  expect(mocks.offer).toHaveBeenCalledWith(expect.objectContaining({ chatId, chatGroupId: undefined }));
  expect(command.maySend.value).toBe(true);
});

it('keeps failed input guarded until retry or explicit cancellation', async () => {
  mocks.inspect.mockResolvedValue('missing');
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(command.operation.value).toMatchObject({ phase: 'error', error: 'missing-model' });
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(command.maySend.value).toBe(false);
  await command.cancel();
  expect(command.maySend.value).toBe(true);
});

it('allows explicit candidate choice with current settings but rejects missing files', async () => {
  mocks.importFiles.mockResolvedValue([model, second]);
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(command.operation.value?.phase).toBe('choosing');
  mocks.settings!.value.defaultModelId = 'updated-remote';
  mocks.inspect.mockResolvedValue('missing');
  await command.choose({ modelId: second.modelId });
  expect(command.operation.value?.error).toBe('missing-model');
  expect(mocks.apply).not.toHaveBeenCalled();
});

it('accepts unrelated settings changes during file traversal', async () => {
  const files = Promise.withResolvers<ModelDirectoryInput[]>();
  const { command } = render({ binding: 'empty-chat' });
  const pending = command.accept({ directories: files.promise, controller: new AbortController() });
  expect(command.maySend.value).toBe(false);
  mocks.settings!.value.defaultModelId = 'another-remote';
  files.resolve([directory]);
  await pending;
  expect(mocks.chat!.value?.modelId).toBe(model.modelId);
  expect(mocks.settings!.value.defaultModelId).toBe('another-remote');
});

it('cancels native traversal promptly without accepting its late result', async () => {
  const files = Promise.withResolvers<ModelDirectoryInput[]>();
  const { command } = render({ binding: 'empty-chat' });
  const pending = command.accept({ directories: files.promise, controller: new AbortController() });
  await command.cancel();
  await pending;
  files.resolve([directory]);
  await flushPromises();
  expect(mocks.importFiles).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(command.maySend.value).toBe(true);
});

it('retries a persistence failure using the already imported files', async () => {
  mocks.apply.mockRejectedValueOnce(new Error('storage unavailable'));
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  await command.retry();
  expect(mocks.importFiles).toHaveBeenCalledOnce();
  expect(mocks.apply).toHaveBeenCalledTimes(2);
  expect(command.maySend.value).toBe(true);
});

it('keeps a successful settings write if session registration needs a retry', async () => {
  mocks.register.mockImplementationOnce(() => {
    throw new Error('session unavailable');
  });
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(mocks.chat!.value?.modelId).toBe(model.modelId);
  expect(command.operation.value?.phase).toBe('error');
  await command.retry();
  expect(mocks.importFiles).toHaveBeenCalledOnce();
  expect(mocks.register).toHaveBeenCalledTimes(2);
});

it('aborts all owned inputs on chat changes and disposal', async () => {
  const first = Promise.withResolvers<ModelDirectoryInput[]>();
  const secondFiles = Promise.withResolvers<ModelDirectoryInput[]>();
  const { command, scope, selected } = render({ binding: 'empty-chat' });
  const pending = command.accept({ directories: first.promise, controller: new AbortController() });
  selected.value = toChatId({ raw: 'next' });
mocks.chat!.value!.id = selected.value;
const next = command.accept({ directories: secondFiles.promise, controller: new AbortController() });
scope.stop();
await Promise.all([pending, next]);
expect(chatLocalModelInputs.value.size).toBe(0);
expect(mocks.apply).not.toHaveBeenCalled();
});

it('starts the normal session only after the live partial update settles', async () => {
  const applied = Promise.withResolvers<boolean>();
  mocks.apply.mockReturnValueOnce(applied.promise);
  const { command } = render({ binding: 'empty-chat' });
  const pending = accept({ command });
  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledOnce());
  expect(mocks.register).not.toHaveBeenCalled();
  mocks.chat!.value!.modelId = model.modelId;
  applied.resolve(true);
  await pending;
  expect(mocks.register).toHaveBeenCalledOnce();
});

it('rechecks nonempty targets and retries after the input becomes usable again', async () => {
  mocks.apply.mockResolvedValueOnce(false);
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(command.operation.value?.error).toBe('not-empty');
  await command.retry();
  expect(command.operation.value).toBeUndefined();
});

it('does not add a settings-change watcher that interrupts pending native reads', async () => {
  const files = Promise.withResolvers<ModelDirectoryInput[]>();
  const { command } = render({ binding: 'empty-chat' });
  const controller = new AbortController();
  const pending = command.accept({ directories: files.promise, controller });
  mocks.settings!.value.experimental = { locale: 'ja' };
  await flushPromises();
  expect(controller.signal.aborted).toBe(false);
  files.resolve([directory]);
  await pending;
  expect(command.maySend.value).toBe(true);
});

it('rejects invalid source handles at commit without replacing existing settings', async () => {
  mocks.sourceCurrent = false;
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(mocks.chat!.value?.modelId).toBeUndefined();
  mocks.sourceCurrent = true;
  await command.retry();
  expect(mocks.chat!.value?.modelId).toBe(model.modelId);
});

it.each(['temp/local:Q4', 'user/local'])('replaces an existing %s binding without whole-chat comparison', async existingModelId => {
  mocks.chat!.value!.modelId = existingModelId;
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(command.operation.value).toBeUndefined();
  expect(mocks.chat!.value?.modelId).toBe(model.modelId);
});

it('accepts live unset inherited title settings and retargets enabled title generation', async () => {
  expect(mocks.chat!.value?.titleGeneration).toBeUndefined();
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(mocks.chat!.value?.titleGeneration).toMatchObject({ endpoint: 'same_scope', model: 'same_scope' });
});

it('does not compare endpoint object property ordering', async () => {
  mocks.chat!.value!.endpoint = { url: 'https://example.invalid', type: 'openai' };
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(command.maySend.value).toBe(true);
});

it('preserves disabled title generation', async () => {
  mocks.chat!.value!.titleGeneration = 'disabled';
  const { command } = render({ binding: 'empty-chat' });
  await accept({ command });
  expect(mocks.chat!.value?.titleGeneration).toBe('disabled');
});

it('shares admission with another pane and accepts only one input per chat', async () => {
  const first = render({ binding: 'empty-chat' });
  const secondPane = render({ binding: 'empty-chat' });
  const files = Promise.withResolvers<ModelDirectoryInput[]>();
  const pending = first.command.accept({ directories: files.promise, controller: new AbortController() });
  expect(secondPane.command.maySend.value).toBe(false);
  await secondPane.command.useModel({ model });
  expect(mocks.apply).not.toHaveBeenCalled();
  await secondPane.command.cancel();
  await pending;
  expect(first.command.maySend.value).toBe(true);
});

it('uses an installed HF selection without enqueuing any download', async () => {
  mocks.installed.mockResolvedValue({ ...model, modelId: target.modelId });
  const { command } = render({ binding: 'empty-chat' });
  await command.useRepositoryModel({ target });
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.chat!.value?.modelId).toBe(target.modelId);
});

it('keeps old settings while downloading and applies only after complete files exist', async () => {
  const done = Promise.withResolvers<{ status: string }>();
  mocks.installed.mockResolvedValueOnce(undefined).mockResolvedValue({ ...model, modelId: target.modelId });
  mocks.enqueue.mockReturnValue({ id: 3, done: done.promise });
  const { command } = render({ binding: 'empty-chat' });
  const pending = command.useRepositoryModel({ target });
  await vi.waitFor(() => expect(command.operation.value?.phase).toBe('downloading'));
  expect(mocks.chat!.value?.modelId).toBeUndefined();
  command.pauseDownload();
  expect(mocks.pause).toHaveBeenCalledWith({ id: 3 });
  done.resolve({ status: 'complete' });
  await pending;
  expect(mocks.chat!.value?.modelId).toBe(target.modelId);
});

it.each(['failed', 'paused', 'cancelled'])('does not apply a %s download', async status => {
  mocks.installed.mockResolvedValue(undefined);
  mocks.enqueue.mockReturnValue({ id: 3, done: Promise.resolve({ status }) });
  const { command } = render({ binding: 'empty-chat' });
  await command.useRepositoryModel({ target });
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(command.operation.value?.phase).toBe('error');
});

it('leaving the picker cancels its wait without cancelling the shared download', async () => {
  mocks.installed.mockResolvedValue(undefined);
  const done = Promise.withResolvers<unknown>();
  mocks.enqueue.mockReturnValue({ id: 3, done: done.promise });
  const { command, scope } = render({ binding: 'empty-chat' });
  const pending = command.useRepositoryModel({ target });
  await vi.waitFor(() => expect(command.operation.value?.phase).toBe('downloading'));
  scope.stop();
  await pending;
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});
