import { chatContentToDomain, chatContentToDto } from '@/00-storage/mapper/mappers';
import type { ChatContent, Endpoint } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import { iterateAttachmentParts } from './message-attachments';
import { cloneLmParameters } from '@/utils/lm-parameters';

export type ChatContentModelBinding = {
  groupId: string | undefined,
  endpoint: Endpoint,
  modelId: string,
  endpointSource: 'chat' | 'chat_group' | 'global',
  modelSource: 'chat' | 'chat_group' | 'global',
};

declare const writeBrand: unique symbol;
/** Page-local authority for one operation, never part of a Chat or its DTO. */
export type ChatContentWrite = { readonly [writeBrand]: true };
type WriteState = {
  id: ChatId,
  baseline: string | undefined,
  binding: ChatContentModelBinding | undefined,
  isCurrent(): boolean,
  tail: Promise<void>,
};
const writes = new WeakMap<ChatContentWrite, WriteState>();

export function chatContentFingerprint({ content }: { content: ChatContent }): string {
  return JSON.stringify(chatContentToDto({ domain: { root: content.root, currentLeafId: content.currentLeafId } }));
}

/** Normalize persisted fields, retaining immutable in-memory attachment bodies. */
export function snapshotChatContent({ content }: { content: ChatContent }): ChatContent {
  const snapshot = chatContentToDomain({ dto: chatContentToDto({ domain: { root: content.root, currentLeafId: content.currentLeafId } }) });
  // The mapper normalizes parameter fields but may retain stop-array identity.
  // Detach mutable parameters before any asynchronous persistence can yield.
  const pending = [...snapshot.root.items];
  while (pending.length > 0) {
    const node = pending.pop()!;
    node.lmParameters = cloneLmParameters({ lmParameters: node.lmParameters });
    pending.push(...node.replies.items);
  }
  const attachments = iterateAttachmentParts({ nodes: content.root.items });
  for (const part of iterateAttachmentParts({ nodes: snapshot.root.items })) {
    const source = attachments.next();
    if (source.done || source.value.attachment.id !== part.attachment.id) {
      throw new Error('The attachment traversal changed while snapshotting chat content');
    }
    // The same attachment ID can appear in several branches with different
    // descriptors. Preserve each occurrence rather than merging them by ID.
    part.attachment = { ...source.value.attachment };
  }
  return snapshot;
}

export function createChatContentWrite({ id, content, binding, isCurrent }: { id: ChatId, content: ChatContent | undefined, binding: ChatContentModelBinding | undefined, isCurrent(): boolean }): ChatContentWrite {
  const write = Object.freeze({}) as ChatContentWrite;
  writes.set(write, { id, baseline: content === undefined ? undefined : chatContentFingerprint({ content }), binding: binding === undefined ? undefined : structuredClone(binding), isCurrent, tail: Promise.resolve() });
  return write;
}

export function readChatContentWrite({ write, id }: { write: ChatContentWrite, id: ChatId }): WriteState {
  const state = writes.get(write);
  if (state === undefined || state.id !== id || !state.isCurrent()) {
    throw new ChatContentBindingChangedError();
  }
  return state;
}

/** Only successful writes advance this operation's baseline; saves are serialized. */
export async function withChatContentWrite<T>({ write, id, operation }: { write: ChatContentWrite, id: ChatId, operation(): Promise<T> }): Promise<T> {
  const state = readChatContentWrite({ write, id });
  const previous = state.tail;
  const finished = Promise.withResolvers<void>();
  state.tail = finished.promise;
  try {
    await previous;
    readChatContentWrite({ write, id });
    return await operation();
  } finally {
    finished.resolve();
  }
}

/** A stale tree must remain available to its owner without replacing newer content. */
export class ChatContentBindingChangedError extends Error {
  constructor() {
    super('The chat model binding changed before its content could be saved');
    this.name = 'ChatContentBindingChangedError';
  }
}

export const TEST_ONLY = {
};
