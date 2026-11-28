import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { Secret } from '@/utils/secret';
import { describe, expect, it, vi } from 'vitest';
import { expose } from 'comlink';
import { WeshKernel } from '@/features/wesh/kernel';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createWeshOwnedBytes, WeshBrokenPipeError, type WeshFileHandle } from '@/features/wesh/types';
import { openFileDescription } from '@/features/wesh/utils/file-input';
import { createWeshWorker, TEST_ONLY } from './impl';
// Load the Worker module graph during test collection.
import './entry';
import type { WeshWorkerRemoteExecutionEvent } from './types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { chatMetaToDomain } from '@/00-format/mapper/mappers';
import type { ChatContent, ChatGroup, ChatMeta } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { chatContentToDto, chatGroupToDto, chatMetaToDto } from '@/00-format/mapper/mappers';
import { renderChatMetadataMarkdown } from '@/features/wesh/naidan-sysfs/render/metadata-markdown';
import {
  naidanSysfsRemoteChatContentPayloadSchema,
  naidanSysfsRemoteChatGroupPayloadSchema,
  naidanSysfsRemoteChatMetaPayloadSchema,
} from '@/features/wesh/naidan-sysfs/remote-reader-schema';
import { toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';

installSecretEqualityTester();

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: <T>(value: T) => value,
}));

const exposedWorker = vi.mocked(expose).mock.calls[0]?.[0];

describe('wesh.worker', () => {
  it('executes a script after initialization', async () => {
    expect(expose).toHaveBeenCalledOnce();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle;

    await exposedWorker.init({
      request: {
        rootHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
      },
    });

    const response = await exposedWorker.execute({ script: 'echo hello' });

    expect(response).toEqual({
      exitCode: 0,
    });
  }, 15000);

  it('includes shell state from the completed input only when requested', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    await root.getDirectoryHandle('workspace', { create: true });
    await workerApi.init({ rootHandle: root, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    await expect(workerApi.execute({ script: 'cd /workspace; export REVIEW_STATE=ready', includeShellState: true })).resolves.toEqual({
      exitCode: 0,
      shellState: { cwd: '/workspace', env: expect.objectContaining({ REVIEW_STATE: 'ready' }) },
    });
    await expect(workerApi.execute({ script: 'pwd' })).resolves.toStrictEqual({ exitCode: 0 });
  });

  it('can read from a mounted directory', async () => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const fileHandle = await mountedRoot.getFileHandle('hello.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('from mount');
    await writable.close();

    await workerApi.init({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      mounts: [{
        type: 'directory',
        path: '/mnt',
        handle: mountedRoot as unknown as FileSystemDirectoryHandle,
        readOnly: true,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const response = await workerApi.execute({ script: 'cat /mnt/hello.txt' });

    expect(response.exitCode).toBe(0);
  });

  it('can read the naidan sysfs version file', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('uploaded-files', { create: true });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot as unknown as FileSystemDirectoryHandle),
      },
    });

    const workerApi = createWeshWorker();
    await workerApi.init({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [{
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        readOnly: true,
        storageType: 'opfs',
        visibility: 'current_chat_only',
        binaryObjectAccess: 'data',
        currentChatId: 'chat-1',
        currentChatGroupId: 'chat-group-1',
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const response = await workerApi.execute({ script: 'cat /sys/fs/naidan/version' });

    expect(response.exitCode).toBe(0);
  });

  it('does not expose naidan sysfs when no naidan sysfs mount is provided', async () => {
    const workerApi = createWeshWorker();
    await workerApi.init({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const response = await workerApi.execute({ script: 'ls /sys/fs/naidan' });

    expect(response.exitCode).toBe(2);
  });

  it('can read naidan sysfs metadata through a local remote reader', async () => {
    const workerApi = createWeshWorker();
    const chatMeta: ChatMeta = {
      id: toChatId({ raw: 'chat-1' }),
      title: 'Local Chat',
      groupId: toChatGroupId({ raw: 'chat-group-1' }),
      currentLeafId: toMessageId({ raw: 'a1chatMetadataAbCdEf' }),
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: false,
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', Secret.from({ value: 'secret-token' })]],
      },
      modelId: 'gpt-5',
      titleGeneration: { endpoint: 'same_scope', model: { id: 'gpt-5-mini' }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: [],
    };
    const chatContent: ChatContent = {
      currentLeafId: toMessageId({ raw: 'a1chatMetadataAbCdEf' }),
      root: { items: [] },
    };
    const chatGroup: ChatGroup = {
      id: toChatGroupId({ raw: 'chat-group-1' }),
      name: 'Local Group',
      isCollapsed: false,
      updatedAt: 200,
      mounts: [],
      endpoint: undefined,
      modelId: undefined,
      titleGeneration: 'inherit',
      systemPrompt: undefined,
      lmParameters: undefined,
      items: [{
        id: 'chat:chat-1',
        type: 'chat',
        chat: {
          id: toChatId({ raw: 'chat-1' }),
          title: 'Local Chat',
          updatedAt: 200,
          groupId: toChatGroupId({ raw: 'chat-group-1' }),
        },
      }],
    };
    const expectedMetadata = chatMetaToDomain({ dto: chatMetaToDto({ domain: chatMeta }) });
    expectedMetadata.groupId = toChatGroupId({ raw: 'chat-group-1' });
    const remoteMetadata = naidanSysfsRemoteChatMetaPayloadSchema.parse({
      dto: chatMetaToDto({ domain: chatMeta }),
      groupId: 'chat-group-1',
    });
    const remoteContent = naidanSysfsRemoteChatContentPayloadSchema.parse(chatContentToDto({ domain: chatContent }));
    const remoteGroup = naidanSysfsRemoteChatGroupPayloadSchema.parse({
      dto: chatGroupToDto({ domain: chatGroup }),
      items: chatGroup.items,
    });

    await workerApi.init(
      {
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [{
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'local',
          visibility: 'current_chat_only',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        }],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      },
      {
        storageType: 'local',
        async getSidebarStructure() {
          return [{
            id: 'chat-group:chat-group-1',
            type: 'chat_group',
            chatGroup: remoteGroup,
          }];
        },
        async listChats() {
          return [{
            id: 'chat-1',
            title: 'Local Chat',
            updatedAt: 200,
            groupId: 'chat-group-1',
          }];
        },
        async listChatGroups() {
          return [remoteGroup];
        },
        async loadChatMeta({ chatId }: { chatId: string }) {
          return chatId === 'chat-1' ? remoteMetadata : undefined;
        },
        async loadChatContent({ chatId }: { chatId: string }) {
          return chatId === 'chat-1' ? remoteContent : undefined;
        },
        async loadChat({ chatId }: { chatId: string }) {
          return chatId === 'chat-1' ? { metadata: remoteMetadata, content: remoteContent } : undefined;
        },
        async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
          return chatGroupId === 'chat-group-1' ? remoteGroup : undefined;
        },
        async listBinaryObjects() {
          return [];
        },
        async getBinaryObject() {
          return undefined;
        },
        async getBinaryObjectBlob() {
          return undefined;
        },
      },
    );

    const stdoutChunks: string[] = [];
    const response = await workerApi.execute(
      { script: 'cat /sys/fs/naidan/chats/chat-1/metadata.md' },
      async (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
        if (event.type === 'stdout') {
          stdoutChunks.push(new TextDecoder().decode(event.buffer));
        }
      },
    );
    expect(response).toEqual({ exitCode: 0 });
    expect(stdoutChunks.join('')).toEqual(renderChatMetadataMarkdown({ metadata: expectedMetadata }));
  });

  it('defers command preloading while an execution is active', async () => {
    const workerApi = createWeshWorker();
    await workerApi.init({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const completion = workerApi.execute({ script: 'sleep 1' });
    await expect(workerApi.preloadNextCommand()).resolves.toEqual({ status: 'busy' });

    await new Promise(resolve => setTimeout(resolve, 20));
    await workerApi.interrupt();
    await expect(completion).resolves.toEqual({ exitCode: 130 });

    await expect(workerApi.preloadNextCommand()).resolves.toEqual({ status: 'advanced' });
  });

  it('observes publication from a persistent descriptor closed in a later input', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getFileHandle('output', { create: true });
    const writer = await target.createWritable({ keepExistingData: true });
    const close = writer.close.bind(writer);
    const publishing = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    using _allowCompletion = {
      [Symbol.dispose]() {
        complete.resolve();
      },
    };
    using _writer = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using _close = vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      publishing.resolve();
      await complete.promise;
      await close();
    });
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });
    await expect(workerApi.execute({ script: 'exec 3>>output; printf saved >&3' })).resolves.toEqual({ exitCode: 0 });

    const execution = workerApi.execute({ script: 'exec 3>&-; printf late > late' });
    await publishing.promise;
    const interrupt = workerApi.interrupt();
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(true);
    complete.resolve();

    await expect(interrupt).resolves.toBe(true);
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(false);
    await expect((await target.getFile()).text()).resolves.toBe('saved');
    await expect(root.getFileHandle('late')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('observes an accepted redirected write before the shell closes its descriptor', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getFileHandle('output', { create: true });
    const writer = await target.createWritable({ keepExistingData: true });
    const write = writer.write.bind(writer);
    const writing = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    using _allowCompletion = {
      [Symbol.dispose]() {
        complete.resolve();
      },
    };
    using _writer = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using _write = vi.spyOn(writer, 'write').mockImplementationOnce(async chunk => {
      writing.resolve();
      await complete.promise;
      await write(chunk);
    });
    using close = vi.spyOn(writer, 'close');
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const execution = workerApi.execute({ script: 'printf saved | cat >> output; printf late > late' });
    await writing.promise;
    const interrupt = workerApi.interrupt();
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(true);
    expect(close).not.toHaveBeenCalled();
    complete.resolve();

    await expect(interrupt).resolves.toBe(true);
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(close).toHaveBeenCalledOnce();
    await expect((await target.getFile()).text()).resolves.toBe('saved');
    await expect(root.getFileHandle('late')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('does not report publication when an untouched writer is being discarded', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getFileHandle('output', { create: true });
    const writer = await target.createWritable({ keepExistingData: true });
    const abort = writer.abort.bind(writer);
    const aborting = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    using _allowCompletion = {
      [Symbol.dispose]() {
        complete.resolve();
      },
    };
    using _writer = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using _abort = vi.spyOn(writer, 'abort').mockImplementationOnce(async reason => {
      aborting.resolve();
      await complete.promise;
      await abort(reason);
    });
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const execution = workerApi.execute({ script: ': >> output; printf late > late' });
    await aborting.promise;
    const interrupt = workerApi.interrupt();
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(false);
    complete.resolve();

    await expect(interrupt).resolves.toBe(true);
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    await expect(root.getFileHandle('late')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('leaves both existing paths intact if stopped during rename staging', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const source = await root.getFileHandle('source', { create: true });
    source.content = new TextEncoder().encode('source data');
    const destination = await root.getFileHandle('destination', { create: true });
    destination.content = new TextEncoder().encode('previous data');
    const writer = await destination.createWritable();
    const staging = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<typeof writer>();
    using _allowCompletion = {
      [Symbol.dispose]() {
        ready.resolve(writer);
      },
    };
    using _writer = vi.spyOn(destination, 'createWritable').mockImplementationOnce(() => {
      staging.resolve();
      return ready.promise;
    });
    using close = vi.spyOn(writer, 'close');
    using abort = vi.spyOn(writer, 'abort');
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const execution = workerApi.execute({ script: 'mv source destination' });
    await staging.promise;
    await expect(workerApi.interrupt()).resolves.toBe(true);
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(false);
    ready.resolve(writer);

    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    await expect((await (await root.getFileHandle('source')).getFile()).text()).resolves.toBe('source data');
    await expect((await (await root.getFileHandle('destination')).getFile()).text()).resolves.toBe('previous data');
  });

  it('preserves a redirection target if stopped before truncate and still runs the shell trap', async () => {
    const workerApi = createWeshWorker();
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getFileHandle('target', { create: true });
    target.content = new TextEncoder().encode('previous data');
    const getFile = target.getFile.bind(target);
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _allowRead = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    using _read = vi.spyOn(target, 'getFile').mockImplementationOnce(async () => {
      reading.resolve();
      await resume.promise;
      return getFile();
    });
    using createWritable = vi.spyOn(target, 'createWritable');
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const output: string[] = [];
    const execution = workerApi.execute({ script: "trap 'printf caught' INT; printf replacement > target; printf late" }, (event: WeshWorkerRemoteExecutionEvent) => {
      if (event.type === 'stdout') {
        output.push(new TextDecoder().decode(event.buffer));
      }
    });
    await reading.promise;
    await expect(workerApi.interrupt()).resolves.toBe(true);
    await expect(workerApi.isInterruptWaitingForFilePublication()).resolves.toBe(false);
    resume.resolve();

    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(output).toEqual(['caught']);
    expect(createWritable).not.toHaveBeenCalled();
    await expect((await getFile()).text()).resolves.toBe('previous data');
  });

  it.each([
    { description: 'a foreground process', command: 'sleep 5; printf extra', sleepCount: 1, output: 'trapped' },
    { description: 'a shell child', command: 'sh -c "sleep 5; printf late > late"; printf extra', sleepCount: 1, output: 'trapped' },
    { description: 'a shell child with its own trap', command: `sh -c "trap -- 'printf child' INT; sleep 5; printf late > late"; printf extra`, sleepCount: 1, output: 'childtrapped' },
    { description: 'a subshell with local INT and EXIT traps', command: `(trap 'printf child-int' INT; trap 'printf child-exit' EXIT; sleep 5; printf late > late)`, sleepCount: 1, output: 'child-intchild-exittrapped' },
    { description: 'a pipeline shell with local INT and EXIT traps', command: `: | { trap 'printf child-int' INT; trap 'printf child-exit' EXIT; sleep 5; printf late > late; }`, sleepCount: 1, output: 'child-intchild-exittrapped' },
    { description: 'a command substitution with local INT and EXIT traps', command: `SAVED=$(trap 'printf child-int >&2' INT; trap 'printf child-exit >&2' EXIT; sleep 5; printf late > late)`, sleepCount: 1, output: 'trapped', errors: 'child-intchild-exit' },
    { description: 'a shell started by xargs', command: 'printf token | xargs sh -c "sleep 5; printf late > late"; printf extra', sleepCount: 1, output: 'trapped' },
    { description: 'each foreground process group in a nested pipeline', command: 'sleep 5 | (sleep 5); printf extra', sleepCount: 2, output: 'trapped' },
    { description: 'both stages of one pipeline', command: 'sleep 5 | sleep 5; printf extra', sleepCount: 2, output: 'trapped' },
    { description: 'an assignment command substitution', command: 'SAVED=$(sleep 5; printf changed); printf extra', sleepCount: 1, output: 'trapped' },
    { description: 'a for loop command substitution', command: 'for SAVED in "$(sleep 5; printf changed)"; do printf extra; done', sleepCount: 1, output: 'trapped' },
  ])('interrupts $description, runs its shell traps once, and skips later commands', async ({ command, sleepCount, output, errors }) => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    await workerApi.init({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: '/',
    });

    await expect(workerApi.execute({ script: "mkdir /saved; cd /saved; export SAVED=yes; alias saved='echo kept'" })).resolves.toEqual({ exitCode: 0 });
    await expect(workerApi.getShellState()).resolves.toMatchObject({ cwd: '/saved', env: { SAVED: 'yes' } });

    const waiting = Promise.withResolvers<void>();
    const waitForSignalOrTimeout = WeshKernel.prototype.waitForSignalOrTimeout;
    let waits = 0;
    const waitSpy = vi.spyOn(WeshKernel.prototype, 'waitForSignalOrTimeout').mockImplementation(function (this: InstanceType<typeof WeshKernel>, options) {
      waits += 1;
      if (waits === sleepCount) {
        waiting.resolve();
      }
      return waitForSignalOrTimeout.call(this, options);
    });
    using _resources = { [Symbol.dispose]: () => waitSpy.mockRestore() };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const execution = workerApi.execute({
      script: `\
trap -- 'printf trapped' INT
${command}
printf next-line
`,
    }, (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
      if (event.type === 'stdout') {
        stdout.push(new TextDecoder().decode(event.buffer));
      }
      if (event.type === 'stderr') {
        stderr.push(new TextDecoder().decode(event.buffer));
      }
    });

    await waiting.promise;
    await expect(workerApi.interrupt()).resolves.toBe(true);
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(stdout.join('')).toBe(output);
    expect(stderr.join('')).toBe(errors ?? '');
    await expect(workerApi.getShellState()).resolves.toMatchObject({ cwd: '/saved', env: { SAVED: 'yes' } });
    expect(await workerApi.listCommands()).toContainEqual(expect.objectContaining({ name: 'saved', kind: 'alias' }));
    const saved = await rootHandle.getDirectoryHandle('saved');
    await expect(saved.getFileHandle('late')).rejects.toThrow();
  });

  it('stops a command that ignores INT while reading a FIFO with a persistent writer', async () => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    await workerApi.init({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const opened = Promise.withResolvers<WeshFileHandle>();
    {
      const open = WeshKernel.prototype.open;
      using _open = vi.spyOn(WeshKernel.prototype, 'open').mockImplementation(async function (this: WeshKernel, options) {
        const handle = await open.call(this, options);
        if (options.path === '/hold') {
          opened.resolve(handle);
        }
        return handle;
      });
      await expect(workerApi.execute({ script: 'mkfifo /hold; exec 3<>/hold' })).resolves.toEqual({ exitCode: 0 });
    }

    const started = Promise.withResolvers<void>();
    const finishedRead = vi.fn();
    const fifoPrototype = Object.getPrototypeOf(await opened.promise) as Pick<WeshFileHandle, 'read'>;
    const read = fifoPrototype.read;
    using _read = vi.spyOn(fifoPrototype, 'read').mockImplementation(function (this: WeshFileHandle, options) {
      const result = read.call(this, options);
      started.resolve();
      void result.then(finishedRead, finishedRead);
      return result;
    });
    const events: WeshWorkerRemoteExecutionEvent[] = [];
    const execution = workerApi.execute({ script: "trap '' INT; cat <&3; printf late" }, (event: WeshWorkerRemoteExecutionEvent) => {
      events.push(event);
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    await Promise.race([started.promise, execution.then(() => {
      throw new Error('Command exited before reading from the FIFO');
    })]);

    await expect(workerApi.interrupt()).resolves.toBe(true);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(events).toEqual([{ type: 'started' }, { type: 'exit', exitCode: 130 }]);
    await vi.waitFor(() => expect(finishedRead).toHaveBeenCalledOnce());

    const stdout: string[] = [];
    await expect(workerApi.execute({ script: 'printf resumed >&3; head -c 7 <&3; exec 3>&-' }, (event: WeshWorkerRemoteExecutionEvent) => {
      if (event.type === 'stdout') {
        stdout.push(new TextDecoder().decode(event.buffer));
      }
    })).resolves.toEqual({ exitCode: 0 });
    expect(stdout.join('')).toBe('resumed');
  });

  it('accepts an interrupt before executing the script while the started callback is pending', async () => {
    const workerApi = createWeshWorker();
    await workerApi.init({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const callback = Promise.withResolvers<void>();
    const execution = workerApi.execute({ script: 'export STARTED=yes' }, () => callback.promise);
    await expect(workerApi.interrupt()).resolves.toBe(true);
    callback.resolve();

    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect((await workerApi.getShellState()).env).not.toHaveProperty('STARTED');
  });

  it('stops after a pending redirection lookup without dispatching the command or later redirections', async () => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    await rootHandle.getFileHandle('blocked', { create: true });
    const lookupStarted = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const getFileHandleSpy = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'blocked') {
        lookupStarted.resolve();
        await lookup.promise;
      }
      return getFileHandle(name, options);
    });
    await workerApi.init({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });

    const out: string[] = [];
    const execution = workerApi.execute({
      script: `\
trap -- 'printf trapped' INT
export RAN=yes <blocked >later; export CONTINUED=yes
`,
    }, (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
      if (event.type === 'stdout') {
        out.push(new TextDecoder().decode(event.buffer));
      }
    });
    await lookupStarted.promise;
    await expect(workerApi.interrupt()).resolves.toBe(true);
    lookup.resolve();

    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(out.join('')).toBe('trapped');
    expect(getFileHandleSpy.mock.calls.some(([name]) => name === 'later')).toBe(false);
    const { env } = await workerApi.getShellState();
    expect(env).not.toHaveProperty('RAN');
    expect(env).not.toHaveProperty('CONTINUED');
  });

  it.each([
    { disposition: 'with the default INT disposition', trap: '' },
    { disposition: 'when the producer and consumer ignore INT', trap: "trap '' INT; " },
  ])('stops a process substitution attached to an earlier descriptor $disposition', async ({ trap }) => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    await rootHandle.getFileHandle('blocked', { create: true });
    const lookupStarted = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const spy = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'blocked') {
        lookupStarted.resolve();
        await lookup.promise;
      }
      return getFileHandle(name, options);
    });
    using _cleanup = {
      [Symbol.dispose]() {
        lookup.resolve();
        spy.mockRestore();
      },
    };
    await workerApi.init({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });
    using pipe = vi.spyOn(WeshKernel.prototype, 'pipe');
    await expect(workerApi.execute({ script: `exec 3< <(${trap}cat blocked; printf stale >late)` })).resolves.toEqual({ exitCode: 0 });
    await lookupStarted.promise;

    expect(pipe).toHaveBeenCalledOnce();
    const ends = await pipe.mock.results[0]?.value;
    if (ends === undefined) {
      throw new Error('Expected a process substitution pipe');
    }
    const description = openFileDescription({ handle: ends.read });
    const pipePrototype = Object.getPrototypeOf(ends.read) as Pick<WeshFileHandle, 'read'>;
    const readFromPipe = pipePrototype.read;
    const waiting = Promise.withResolvers<{ pendingRead: ReturnType<WeshFileHandle['read']> }>();
    using _pipeRead = vi.spyOn(pipePrototype, 'read').mockImplementation(function (this: WeshFileHandle, options) {
      const pendingRead = readFromPipe.call(this, options);
      if (openFileDescription({ handle: this }) === description) {
        waiting.resolve({ pendingRead });
      }
      return pendingRead;
    });
    const read = workerApi.execute({ script: `${trap}cat <&3` });
    const { pendingRead } = await Promise.race([waiting.promise, read.then(() => {
      throw new Error('Consumer exited before reading the process substitution pipe');
    })]);
    expect(await Promise.race([pendingRead, undefined])).toBeUndefined();
    await expect(workerApi.interrupt()).resolves.toBe(true);
    lookup.resolve();

    await expect(read).resolves.toEqual({ exitCode: 130 });
    await expect(workerApi.execute({ script: 'cat <&3; exec 3<&-' })).resolves.toEqual({ exitCode: 0 });
    expect(spy.mock.calls.some(([name]) => name === 'late')).toBe(false);
  });

  it('seals an input’s stdout before exit while a process substitution still holds it', async () => {
    const workerApi = createWeshWorker();
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const outputFinished = Promise.withResolvers<void>();
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const spy = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'marker' && options?.create) {
        outputFinished.resolve();
      }
      return getFileHandle(name, options);
    });
    using _spy = { [Symbol.dispose]: () => spy.mockRestore() };
    await workerApi.init({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });
    const events: WeshWorkerRemoteExecutionEvent[] = [];
    await expect(workerApi.execute({ script: 'exec 3> >(cat && printf finished >marker); printf ready' }, (event: WeshWorkerRemoteExecutionEvent) => {
      events.push(event);
    })).resolves.toEqual({ exitCode: 0 });

    await expect(workerApi.execute({ script: 'seq >&3 1 20000; exec 3>&-' })).resolves.toEqual({ exitCode: 0 });
    await outputFinished.promise;
    expect(events.map(({ type }) => type)).toEqual(['started', 'stdout', 'exit']);
  });

  it('preserves output callback failures and still attempts an error event', async () => {
    const workerApi = createWeshWorker();
    await workerApi.init({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const events: Array<import('./types').WeshWorkerRemoteExecutionEvent> = [];
    const completion = workerApi.execute(
      { script: 'echo forwarded-output' },
      async (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
        events.push(event);
        if (event.type === 'stdout') {
          throw new Error('stdout callback failed');
        }
      },
    );

    await expect(completion).rejects.toThrow('Wesh execution failed while forwarding worker events');
    expect(events.some(event => event.type === 'error')).toBe(true);
  });

  it('streams stdout and stderr events before execute resolves', async () => {
    const workerApi = createWeshWorker();
    await workerApi.init({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const events: Array<import('./types').WeshWorkerRemoteExecutionEvent> = [];
    const completion = workerApi.execute(
      {
        script: 'echo before-stream; echo partial-error >&2',
      },
      async (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
        events.push(event);
      },
    );
    const response = await completion;

    const decoder = new TextDecoder();
    const stdoutOutput = events
      .filter((event): event is Extract<typeof event, { type: 'stdout' }> => event.type === 'stdout')
      .map(event => decoder.decode(event.buffer))
      .join('');
    const stderrOutput = events
      .filter((event): event is Extract<typeof event, { type: 'stderr' }> => event.type === 'stderr')
      .map(event => decoder.decode(event.buffer))
      .join('');

    expect(events.some(event => event.type === 'started')).toBe(true);
    expect(stdoutOutput).toContain('before-stream');
    expect(stderrOutput).toContain('partial-error');
    expect(events.some(event => event.type === 'exit' && event.exitCode === 0)).toBe(true);
    expect(response.exitCode).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)('bounds buffered %s across timer flushes while an acknowledgement is pending', async stream => {
    vi.useFakeTimers();
    using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    using _acknowledge = {
      [Symbol.dispose]: () => {
        first.resolve();
        second.resolve();
      },
    };
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const delivered: string[] = [];
    const { handle, finish } = TEST_ONLY.createForwardingHandle({
      stream,
      onEvent: async ({ event }) => {
        if (event.type !== stream) {
          throw new Error(`Unexpected event: ${event.type}`);
        }
        delivered.push(decoder.decode(event.buffer));
        await (delivered.length === 1 ? first.promise : second.promise);
      },
    });
    const write = ({ text }: { text: string }) => handle.write({ buffer: encoder.encode(text) });
    const prefix = 'a'.repeat(16 * 1024);
    const suffix = 'b'.repeat(16 * 1024);

    await write({ text: 'first' });
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered).toEqual(['first']);
    await write({ text: prefix });
    await vi.advanceTimersByTimeAsync(10);
    const wrote = vi.fn();
    const writePending = write({ text: suffix }).then(wrote);
    await vi.advanceTimersByTimeAsync(10);
    expect(wrote).not.toHaveBeenCalled();

    const drained = vi.fn();
    const finishPending = finish().then(drained);
    const lateWrite = write({ text: 'after exit' });
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['first', prefix + suffix]);
    expect(drained).not.toHaveBeenCalled();
    second.resolve();
    await Promise.all([writePending, finishPending]);
    await expect(lateWrite).resolves.toEqual({ bytesWritten: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered).toEqual(['first', prefix + suffix]);
    expect(drained).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('frames 128 KiB of borrowed and owned data and omits unused backing regions', async () => {
    const sent: ArrayBuffer[] = [];
    const { handle, finish } = TEST_ONLY.createForwardingHandle({
      stream: 'stdout',
      onEvent: async ({ event }) => {
        if (event.type === 'stdout') {
          sent.push(event.buffer);
        }
      },
    });
    const frameSize = 32 * 1024;
    const length = 4 * frameSize;
    const offset = 11;
    const input = new Uint8Array(offset + length + 13).fill(0xff);
    for (let index = 0; index < 4; index++) {
      input.fill(index, offset + index * frameSize, offset + (index + 1) * frameSize);
    }
    await expect(handle.write({ buffer: input, offset, length })).resolves.toEqual({ bytesWritten: length });
    expect(input.byteLength).toBe(offset + length + 13);
    expect(sent.map(buffer => buffer.byteLength)).toEqual([frameSize, frameSize, frameSize, frameSize]);
    for (const [index, frame] of sent.entries()) {
      expect(new Uint8Array(frame).every(byte => byte === index)).toBe(true);
    }

    const owned = new Uint8Array(length).fill(0x6f);
    await handle.writeOwned?.({ chunk: createWeshOwnedBytes({ bytes: owned }) });
    expect(sent.slice(4).map(buffer => buffer.byteLength)).toEqual([frameSize, frameSize, frameSize, frameSize]);
    for (const frame of sent.slice(4)) {
      expect(new Uint8Array(frame).every(byte => byte === 0x6f)).toBe(true);
      expect(frame).not.toBe(owned.buffer);
    }

    const backing = new Uint8Array(2 * 1024 * 1024).fill(0xff);
    const view = backing.subarray(997, 2021).fill(0x7a);
    const survivor = handle.cloneReference?.();
    if (survivor === undefined) {
      throw new Error('Expected a duplicate output descriptor');
    }
    await handle.writeOwned?.({ chunk: createWeshOwnedBytes({ bytes: view }) });
    await finish();
    await expect(handle.writeOwned?.({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array([1]) }) })).rejects.toBeInstanceOf(WeshBrokenPipeError);
    const late = new Uint8Array([0x6c]);
    await expect(survivor.write({ buffer: late })).resolves.toEqual({ bytesWritten: 1 });
    await survivor.writeOwned?.({ chunk: createWeshOwnedBytes({ bytes: late }) });
    await survivor.close();
    await expect(survivor.write({ buffer: late })).resolves.toEqual({ bytesWritten: 0 });
    expect(sent).toHaveLength(9);
    expect(sent[8]?.byteLength).toBe(view.byteLength);
    expect(new Uint8Array(sent[8]!).every(byte => byte === 0x7a)).toBe(true);
    expect(sent[8]).not.toBe(backing.buffer);
    await handle.close();
  });

  it('drains a borrowed write admitted before finish even if its descriptor closes while waiting', async () => {
    const acknowledgement = Promise.withResolvers<void>();
    using _acknowledge = { [Symbol.dispose]: () => acknowledgement.resolve() };
    const firstFrame = Promise.withResolvers<void>();
    const delivered: Uint8Array[] = [];
    const { handle, finish } = TEST_ONLY.createForwardingHandle({
      stream: 'stdout',
      onEvent: async ({ event }) => {
        if (event.type === 'stdout') {
          delivered.push(new Uint8Array(event.buffer));
          if (delivered.length === 1) {
            firstFrame.resolve();
            await acknowledgement.promise;
          }
        }
      },
    });
    const secondary = handle.cloneReference?.();
    if (secondary === undefined) {
      throw new Error('Expected a duplicate output descriptor');
    }
    const first = handle.write({ buffer: new Uint8Array(32 * 1024).fill(0x61) });
    await firstFrame.promise;

    const borrowed = new Uint8Array([0x62, 0x62]);
    const accepted = vi.fn();
    const queued = secondary.write({ buffer: borrowed }).then(result => {
      accepted();
      return result;
    });
    await secondary.close();
    const ending = finish();
    await expect(handle.write({ buffer: new Uint8Array([0x63]) })).resolves.toEqual({ bytesWritten: 0 });
    expect(accepted).not.toHaveBeenCalled();

    acknowledgement.resolve();
    await expect(first).resolves.toEqual({ bytesWritten: 32 * 1024 });
    await expect(queued).resolves.toEqual({ bytesWritten: 2 });
    borrowed.fill(0);
    await ending;
    expect(delivered.map(frame => frame.byteLength)).toEqual([32 * 1024, 2]);
    expect(delivered[1]).toEqual(new Uint8Array([0x62, 0x62]));
    await handle.close();
  });
});
