import { vi } from 'vitest';
import { toRaw } from 'vue';
import type { StorageService } from '@/00-storage/service';
import type { Chat, ChatContent, ChatMeta, Settings } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import { createChatContentWrite, snapshotChatContent } from '@/00-storage/service/chat-content-binding';

type Fixture = { metadata: Map<ChatId, ChatMeta>, contents: Map<ChatId, ChatContent> };
const fixtures = new WeakMap<StorageService, Fixture>();

function snapshotMetadata({ metadata }: { metadata: ChatMeta }): ChatMeta {
  const copied = { ...metadata };
  Reflect.deleteProperty(copied, 'root');
  return cloneFixtureMetadata({ value: copied });
}

function cloneFixtureMetadata<T>({ value }: { value: T }): T {
  if (Array.isArray(value)) {
    return value.map(value => cloneFixtureMetadata({ value })) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(toRaw(value)).map(([key, value]) => [key, cloneFixtureMetadata({ value })])) as T;
  }
  return value;
}

/** Guard plumbing for retained behavior tests; storage CAS has real-service tests. */
export function installLegacyChatStorageFixture({ storage, getSettings }: { storage: StorageService, getSettings(): Settings }): void {
  if (fixtures.has(storage) || (!vi.isMockFunction(storage.init) && !vi.isMockFunction(storage.getModelLaunch))) {
    return;
  }
  const fixture: Fixture = { metadata: new Map(), contents: new Map() };
  fixtures.set(storage, fixture);
  storage.captureSettingsStorage ??= () => () => true;
  storage.getCurrentType ??= () => getSettings().storageType;
  storage.createChatContentWrite = ({ id, content, binding }) => createChatContentWrite({ id, content, binding, isCurrent: () => true });
  if (storage.loadChat !== undefined) {
    storage.loadChat = new Proxy(storage.loadChat, {
      async apply(target, receiver, args) {
        const chat = await Reflect.apply(target, receiver, args) as Chat | null | undefined;
        if (chat !== null && chat !== undefined && chat.root !== undefined && chat.createdAt !== undefined) {
          fixture.metadata.set(chat.id, snapshotMetadata({ metadata: chat }));
          fixture.contents.set(chat.id, snapshotChatContent({ content: chat }));
        }
        return chat;
      },
    });
  }
  storage.loadChatForModelBinding = async ({ id }) => {
    const loaded = await storage.loadChat?.({ id });
    const complete = loaded?.createdAt === undefined ? undefined : loaded;
    const metadata = complete ?? fixture.metadata.get(id);
    const content = complete?.root === undefined ? fixture.contents.get(id) : complete;
    const chat = metadata === undefined || content === undefined ? null : { ...snapshotMetadata({ metadata }), ...snapshotChatContent({ content }) };
    return { status: 'loaded', chat, isCurrent: () => true };
  };
  const loadSettings = storage.loadSettings;
  storage.loadSettings = async () => {
    const loaded = await loadSettings?.();
    return loaded?.endpoint === undefined ? getSettings() : loaded;
  };
  const updateMetadata = storage.updateChatMeta ?? vi.fn<StorageService['updateChatMeta']>();
  storage.updateChatMeta = new Proxy(updateMetadata, {
    async apply(target, receiver, args) {
      const [input] = args as [Parameters<StorageService['updateChatMeta']>[0]];
      let proposal: Promise<ChatMeta | undefined> | undefined;
      let active = true;
      const updater: typeof input.updater = ({ current }) => {
        const acceptedCurrent = active && (current === null || current.id !== input.id || current.createdAt === undefined)
          ? fixture.metadata.get(input.id) ?? null
          : current;
        const updated = input.updater({ current: acceptedCurrent });
        proposal = Promise.resolve(updated);
        return updated;
      };
      await Reflect.apply(target, receiver, [{ ...input, updater }]);
      proposal ??= Promise.resolve(input.updater({ current: fixture.metadata.get(input.id) ?? null }));
      const accepted = await proposal;
      active = false;
      if (accepted !== undefined) {
        fixture.metadata.set(input.id, snapshotMetadata({ metadata: accepted }));
      }
    },
  });
  const updateContent = storage.updateChatContent;
  storage.updateChatContent = new Proxy(updateContent, {
    async apply(target, receiver, args) {
      const [input] = args as [Parameters<StorageService['updateChatContent']>[0]];
      let proposal: Promise<ChatContent> | undefined;
      const updater: typeof input.updater = ({ current }) => {
        const updated = input.updater({ current: fixture.contents.get(input.id) ?? current });
        proposal = Promise.resolve(updated);
        return updated;
      };
      await Reflect.apply(target, receiver, [{ ...input, updater }]);
      proposal ??= Promise.resolve(input.updater({ current: fixture.contents.get(input.id) ?? null }));
      const accepted = snapshotChatContent({ content: await proposal });
      fixture.contents.set(input.id, accepted);
      return snapshotChatContent({ content: accepted });
    },
  });
  if (storage.deleteChat !== undefined) {
    storage.deleteChat = new Proxy(storage.deleteChat, {
      async apply(target, receiver, args) {
        const [input] = args as [Parameters<StorageService['deleteChat']>[0]];
        await Reflect.apply(target, receiver, args);
        fixture.metadata.delete(input.id);
        fixture.contents.delete(input.id);
      },
    });
  }
}

/** Explicitly supplying a Chat in a legacy fixture also supplies its saved base. */
export function seedLegacyChatStorageFixture({ storage, chat }: { storage: StorageService, chat: Chat }): void {
  const fixture = fixtures.get(storage);
  if (fixture === undefined || fixture.metadata.has(chat.id)) {
    return;
  }
  fixture.metadata.set(chat.id, snapshotMetadata({ metadata: chat }));
  fixture.contents.set(chat.id, snapshotChatContent({ content: chat }));
}

export function resetLegacyChatStorageFixture({ storage }: { storage: StorageService }): void {
  const fixture = fixtures.get(storage);
  fixture?.metadata.clear();
  fixture?.contents.clear();
}

export const TEST_ONLY = {
};
