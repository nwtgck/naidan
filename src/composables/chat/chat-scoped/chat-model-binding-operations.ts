import { sameLocalModelBinding } from '@/00-storage/service/local-model-references';
import { watch } from 'vue';
import { chatLocalModelInputs } from './chat-local-model-input';
import { idToRaw, type ChatId, type MessageId } from '@/01-models/ids';
import type { AssistantMessageNode, Chat, Endpoint } from '@/01-models/types';
import { chatModelBindingAssistantFingerprint } from '@/01-models/chat-message';
import { areEndpointsEqual, cloneEndpoint } from '@/01-models/endpoint';
import { storageService, ChatContentBindingChangedError, type ChatContentWrite, type ChatContentModelBinding } from '@/00-storage/service';
import { retainLocalRepositorySource } from '@/features/llama-cpp-browser/local-repository-lifetime';
import { chatContentFingerprint, readChatContentWrite } from '@/00-storage/service/chat-content-binding';
import { useSettings } from '@/composables/useSettings';
import { getLiveChatById, isProcessing, loadData, rootItems, synchronizeModelBindingContent } from '@/composables/chat/global/chat-core-singletons';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { findNodeInBranch } from '@/logic/chat-tree';
import { temporaryModelFiles } from '@/logic/temporary-model-files';

type BindingLane = {
  active: number,
  finalizers: number,
  finalizationTail: Promise<void>,
  drained: (() => void)[],
};

export type ChatModelBindingOperation = {
  captureModelSource({ endpoint, modelId }: { endpoint: Endpoint, modelId: string }): void,
  retain(): ChatModelBindingOperation,
  release(): void,
};

const lanes = new Map<ChatId, BindingLane>();

/** The pending input is the only page-local guard before normal preparation. */
export function hasChatLocalModelPreparation({ chatId }: { chatId: ChatId }): boolean {
  return chatLocalModelInputs.value.has(chatId);
}

export function captureChatLocalModelAdmission({ chatId }: { chatId: ChatId }): { assertCurrent(): void } {
  const assertCurrent = () => {
    if (hasChatLocalModelPreparation({ chatId })) {
      throw new ChatContentBindingChangedError();
    }
  };
  assertCurrent();
  return { assertCurrent };
}

function laneFor({ chatId }: { chatId: ChatId }): BindingLane {
  const existing = lanes.get(chatId);
  if (existing) {
    return existing;
  }
  const lane: BindingLane = { active: 0, finalizers: 0, finalizationTail: Promise.resolve(), drained: [] };
  lanes.set(chatId, lane);
  return lane;
}

function releaseLane({ chatId, lane }: { chatId: ChatId, lane: BindingLane }): void {
  if (lane.active === 0 && lane.finalizers === 0 && lanes.get(chatId) === lane) {
    lanes.delete(chatId);
  }
}

function retainOperation({ chatId, lane }: { chatId: ChatId, lane: BindingLane }): ChatModelBindingOperation {
  let sourcePin: { modelId: string, release(): void } | undefined;
  function captureModelSource({ endpoint, modelId }: { endpoint: Endpoint, modelId: string }): void {
    if (sourcePin && sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourcePin.modelId }, right: { endpoint, modelId } })) {
      return;
    }
    const next = (() => {
      switch (endpoint.type) {
      case 'llama_cpp_browser': return retainLocalRepositorySource({ modelId });
      case 'openai': case 'ollama': case 'transformers_js': case 'browser_provided_lm': case 'naidan_rpc': case 'unsupported_experimental_endpoint': return undefined;
      default: {
        const exhaustive: never = endpoint;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const previous = sourcePin;
    sourcePin = next === undefined ? undefined : { modelId, release: () => next.release() };
    previous?.release();
  }
  let retained = 0;
  // Retaining an admitted operation transfers the same captured source to its
  // background work. Only an independent admission resolves the current model.
  function retain(): ChatModelBindingOperation {
    retained++;
    lane.active++;
    let released = false;
    return {
      captureModelSource({ endpoint, modelId }) {
        if (released) {
          throw new Error('The chat model binding operation has finished');
        }
        captureModelSource({ endpoint, modelId });
      },
      retain() {
        if (released) {
          throw new Error('The chat model binding operation has finished');
        }
        return retain();
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        retained--;
        if (retained === 0) {
          sourcePin?.release();
        }
        lane.active--;
        if (lane.active === 0) {
          for (const resolve of lane.drained.splice(0)) {
            resolve();
          }
        }
        releaseLane({ chatId, lane });
      },
    };
  }
  return retain();
}

/** Page-local admission only. Copying model files never acquires this fence. */
export function acquireChatModelBindingOperation({ chatId }: { chatId: ChatId }): ChatModelBindingOperation | Promise<ChatModelBindingOperation> {
  const lane = laneFor({ chatId });
  if (lane.finalizers === 0) {
    return retainOperation({ chatId, lane });
  }
  return lane.finalizationTail.then(() => acquireChatModelBindingOperation({ chatId }));
}

async function runBindingOperation<T>({ bindingOperation, operation }: { bindingOperation: ChatModelBindingOperation, operation: ({ bindingOperation }: { bindingOperation: ChatModelBindingOperation }) => Promise<T> }): Promise<T> {
  try {
    return await operation({ bindingOperation });
  } finally {
    bindingOperation.release();
  }
}

export function withChatModelBindingOperation<T>({ chatId, operation }: { chatId: ChatId, operation: ({ bindingOperation }: { bindingOperation: ChatModelBindingOperation }) => Promise<T> }): Promise<T> {
  const admission = acquireChatModelBindingOperation({ chatId });
  return 'then' in admission
    ? admission.then(bindingOperation => runBindingOperation({ bindingOperation, operation }))
    : runBindingOperation({ bindingOperation: admission, operation });
}

function readContentModelBinding({ chat }: { chat: Chat | Readonly<Chat> }): ChatContentModelBinding {
  const resolved = resolveChatSettings({
    chat,
    groups: rootItems.value.flatMap(item => {
      switch (item.type) {
      case 'chat': return [];
      case 'chat_group': return [item.chatGroup];
      default: {
        const exhaustive: never = item;
        throw new Error(String(exhaustive));
      }
      }
    }),
    globalSettings: useSettings().settings.value,
  });
  return { groupId: chat.groupId == null ? undefined : idToRaw({ id: chat.groupId }), endpoint: cloneEndpoint({ endpoint: resolved.endpoint }), modelId: resolved.modelId, endpointSource: resolved.sources.endpoint, modelSource: resolved.sources.modelId };
}

/** Capture the pre-mutation tree and the model an operation actually depends on. */
export function captureChatContentWrite({ chat, ...input }: { chat: Chat | Readonly<Chat> } & ({ dependency: 'model', bindingOperation: ChatModelBindingOperation | undefined } | { dependency: 'content' })): ChatContentWrite {
  let binding;
  switch (input.dependency) {
  case 'content': binding = undefined;
    break;
  case 'model': binding = readContentModelBinding({ chat });
    input.bindingOperation?.captureModelSource({ endpoint: binding.endpoint, modelId: binding.modelId });
    break;
  default: {
    const exhaustive: never = input;
    throw new Error(String(exhaustive));
  }
  }
  return storageService.createChatContentWrite({ id: chat.id, content: chat, binding });
}

/** Reject already-known stale editor proposals before attachment side effects.
 * Persistence still rechecks the latest stored content and binding at commit. */
export function assertChatContentWriteCurrent({ chat, write, bindingOperation }: { chat: Chat | Readonly<Chat>, write: ChatContentWrite, bindingOperation: ChatModelBindingOperation }): void {
  const expected = readChatContentWrite({ write, id: chat.id });
  if (expected.baseline !== chatContentFingerprint({ content: chat })) {
    throw new ChatContentBindingChangedError();
  }
  if (expected.binding !== undefined) {
    const actual = readContentModelBinding({ chat });
    if (actual.groupId !== expected.binding.groupId || !sameLocalModelBinding({ left: actual, right: expected.binding })
      || actual.endpointSource !== expected.binding.endpointSource || actual.modelSource !== expected.binding.modelSource
    ) {
      throw new ChatContentBindingChangedError();
    }
    bindingOperation.captureModelSource({ endpoint: actual.endpoint, modelId: actual.modelId });
  }
}

/** Refresh promoted/temporary owners before an admitted operation decides its model. */
export async function synchronizeChatModelBindingAdmission({ chatId }: { chatId: ChatId }): Promise<'synchronized' | 'changed'> {
  const isCurrent = storageService.captureSettingsStorage();
  // Replacing a clean snapshot would detach the node an active stream is filling.
  if (isProcessing({ chatId })) {
    return 'changed';
  }
  const outcome = await synchronizeModelBindingContent({ chatId });
  switch (outcome) {
  case 'changed': return outcome;
  case 'synchronized': break;
  default: {
    const exhaustive: never = outcome;
    throw new Error(String(exhaustive));
  }
  }
  await loadData();
  if (!isCurrent()) {
    return 'changed';
  }
  return useSettings().synchronizeModelBindingSettings({ isCurrent });
}

/** The callback must not wait for long resource locks: retry those outside the fence. */
export async function withChatModelBindingFinalization<T>({ chatId, operation }: { chatId: ChatId, operation: () => Promise<T> }): Promise<T> {
  const lane = laneFor({ chatId });
  const previous = lane.finalizationTail;
  const finished = Promise.withResolvers<void>();
  lane.finalizers++;
  lane.finalizationTail = finished.promise;
  try {
    await previous;
    if (lane.active > 0) {
      await new Promise<void>(resolve => lane.drained.push(resolve));
    }
    return await operation();
  } finally {
    lane.finalizers--;
    finished.resolve();
    releaseLane({ chatId, lane });
  }
}

type BindingSnapshot = {
  chatGroupId: Chat['groupId'],
  endpoint: Endpoint,
  modelId: string,
  endpointSource: 'chat' | 'chat_group' | 'global',
  modelSource: 'chat' | 'chat_group' | 'global',
};

type BindingOrigin = {
  chatId: ChatId,
  modelId: string,
  isCurrent(): boolean,
  messages: Map<MessageId, string>,
  valid: boolean,
  stop(): void,
  readBinding(): BindingSnapshot,
};

const origins = new Map<ChatId, BindingOrigin>();
const proofs = new Map<ChatId, Set<{ invalidate(): void }>>();

function invalidateHistoryProofs({ chatId }: { chatId: ChatId }): void {
  for (const proof of [...(proofs.get(chatId) ?? [])]) {
    proof.invalidate();
  }
}

function invalidateOrigin({ origin }: { origin: BindingOrigin }): void {
  origin.valid = false;
  origin.messages.clear();
  origin.stop();
  if (origins.get(origin.chatId) === origin) {
    origins.delete(origin.chatId);
  }
}

/** An explicit local-model action can own subsequent history in an empty chat. */
export function registerChatModelBindingOrigin({ chatId, modelId, isCurrent }: { chatId: ChatId, modelId: string, isCurrent: () => boolean }): boolean {
  const chat = getLiveChatById({ chatId });
  if (!chat || chat.root.items.length !== 0 || !isCurrent()) {
    return false;
  }
  const previous = origins.get(chatId);
  if (previous) {
    invalidateOrigin({ origin: previous });
  }
  const origin: BindingOrigin = {
    chatId,
    modelId,
    isCurrent,
    messages: new Map(),
    valid: true,
    stop: () => {},
    readBinding: () => {
      throw new Error('The chat binding is not initialized');
    },
  };
  origins.set(chatId, origin);
  // Keep only the binding when its view is retired, never the message tree.
  const detachedBinding: Chat = { id: chatId, title: null, root: { items: [] }, createdAt: chat.createdAt, updatedAt: chat.updatedAt, debugEnabled: false, groupId: chat.groupId, endpoint: chat.endpoint === undefined ? undefined : cloneEndpoint({ endpoint: chat.endpoint }), modelId: chat.modelId };
  const readBinding = () => {
    const live = getLiveChatById({ chatId });
    if (live) {
      detachedBinding.groupId = live.groupId;
      detachedBinding.endpoint = live.endpoint === undefined ? undefined : cloneEndpoint({ endpoint: live.endpoint });
      detachedBinding.modelId = live.modelId;
    }
    const binding = live ?? detachedBinding;
    const resolved = resolveChatSettings({
      chat: binding,
      groups: rootItems.value.flatMap(item => {
        switch (item.type) {
        case 'chat': return [];
        case 'chat_group': return [item.chatGroup];
        default: {
          const exhaustive: never = item;
          throw new Error(String(exhaustive));
        }
        }
      }),
      globalSettings: useSettings().settings.value,
    });
    return { chatGroupId: binding.groupId, endpoint: cloneEndpoint({ endpoint: resolved.endpoint }), modelId: resolved.modelId, endpointSource: resolved.sources.endpoint, modelSource: resolved.sources.modelId };
  };
  const initial = readBinding();
  origin.readBinding = readBinding;
  if (!sameLocalModelBinding({ left: initial, right: { endpoint: { type: 'llama_cpp_browser' }, modelId } })) {
    invalidateOrigin({ origin });
    return false;
  }
  const stopWatch = watch(readBinding, next => {
    // The lightweight binding remains observable while its live view is absent.
    if (next.chatGroupId !== initial.chatGroupId || !sameLocalModelBinding({ left: next, right: initial })
      || next.endpointSource !== initial.endpointSource || next.modelSource !== initial.modelSource
    ) {
      invalidateOrigin({ origin });
    }
  }, { flush: 'sync' });
  const unsubscribe = storageService.subscribeToChanges({
    listener: ({ event }) => {
      switch (event.type) {
      case 'migration': invalidateHistoryProofs({ chatId });
        invalidateOrigin({ origin });
        break;
      case 'chat_content': case 'chat_content_generation':
        if (event.id === idToRaw({ id: chatId })) {
          invalidateHistoryProofs({ chatId });
          invalidateOrigin({ origin });
        }
        break;
      case 'chat_meta_and_chat_group': case 'settings': case 'binary_objects': case 'naidan_rpc_registry': break;
      default: {
        const exhaustive: never = event;
        throw new Error(String(exhaustive));
      }
      }
    },
  });
  const retireSource = () => {
    if (!origin.isCurrent()) {
      invalidateHistoryProofs({ chatId });
      invalidateOrigin({ origin });
    }
  };
  const stopStorageWatch = watch(() => useSettings().settings.value, retireSource, { flush: 'sync' });
  const stopFileWatch = temporaryModelFiles.subscribe({ listener: retireSource });
  origin.stop = () => {
    stopWatch();
    stopStorageWatch();
    stopFileWatch();
    unsubscribe();
  };
  return true;
}

export function getKnownChatModelBindingMessages({ chatId, modelId }: { chatId: ChatId, modelId: string }): readonly MessageId[] {
  const origin = origins.get(chatId);
  if (!origin || !origin.valid || !sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: origin.modelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId } })) {
    return [];
  }
  if (!origin.isCurrent()) {
    invalidateHistoryProofs({ chatId });
    invalidateOrigin({ origin });
    return [];
  }
  return [...origin.messages.keys()];
}

export type ChatModelBindingHistoryProof = {
  messageIds: readonly MessageId[],
  fingerprints: ReadonlyMap<MessageId, string>,
  isCurrent(): boolean,
  release(): void,
  allowPromotion({ modelId }: { modelId: string }): void,
};

/** Retried writes retain the generated content proof across their own binding updates. */
export function captureChatModelBindingHistoryProof({ chatId, modelId }: { chatId: ChatId, modelId: string }): ChatModelBindingHistoryProof {
  const origin = origins.get(chatId);
  const messageIds = getKnownChatModelBindingMessages({ chatId, modelId });
  const fingerprints = new Map(messageIds.flatMap(id => {
    const fingerprint = origin?.messages.get(id);
    return fingerprint === undefined ? [] : [[id, fingerprint] as const];
  }));
  let valid = origin !== undefined && origin.valid && origin.isCurrent();
  let allowedModelId: string | undefined;
  let stop = () => {};
  const proof = {
    invalidate() {
      valid = false;
      stop();
      proofs.get(chatId)?.delete(proof);
      if (proofs.get(chatId)?.size === 0) {
        proofs.delete(chatId);
      }
    },
  };
  if (valid && origin !== undefined) {
    const owners = proofs.get(chatId) ?? new Set();
    owners.add(proof);
    proofs.set(chatId, owners);
    const initial = origin.readBinding();
    let promoted = false;
    const stopBindingWatch = watch(() => origin.readBinding(), next => {
      if (next.chatGroupId !== initial.chatGroupId || next.endpoint.type !== 'llama_cpp_browser') {
        proof.invalidate();
        return;
      }
      if (allowedModelId !== undefined && next.modelId === allowedModelId) {
        promoted = true;
        return;
      }
      if (promoted || !sameLocalModelBinding({ left: next, right: initial }) || next.endpointSource !== initial.endpointSource
        || next.modelSource !== initial.modelSource || !areEndpointsEqual({ left: next.endpoint, right: initial.endpoint })) {
        proof.invalidate();
      }
    }, { flush: 'sync' });
    const stopChanges = storageService.subscribeToChanges({
      listener: ({ event }) => {
        switch (event.type) {
        case 'migration': proof.invalidate();
          break;
        case 'chat_content': case 'chat_content_generation':
          if (event.id === idToRaw({ id: chatId })) {
            proof.invalidate();
          }
          break;
        case 'chat_meta_and_chat_group': case 'settings': case 'binary_objects': case 'naidan_rpc_registry': break;
        default: {
          const exhaustive: never = event;
          throw new Error(String(exhaustive));
        }
        }
      },
    });
    const retireSource = () => {
      if (!origin?.isCurrent()) {
        proof.invalidate();
      }
    };
    const stopStorageWatch = watch(() => useSettings().settings.value, retireSource, { flush: 'sync' });
    const stopFileWatch = temporaryModelFiles.subscribe({ listener: retireSource });
    stop = () => {
      stopBindingWatch();
      stopChanges();
      stopStorageWatch();
      stopFileWatch();
    };
  }
  return {
    messageIds,
    fingerprints,
    isCurrent() {
      if (!origin?.isCurrent()) {
        proof.invalidate();
      }
      return valid;
    },
    release: proof.invalidate,
    allowPromotion({ modelId }) {
      allowedModelId = modelId;
    },
  };
}

export function beginChatModelBindingGeneration({ chatId, endpoint, modelId }: { chatId: ChatId, endpoint: Endpoint, modelId: string }): {
  recordAssistant({ messageId }: { messageId: MessageId }): void,
  finish({ persisted }: { persisted: boolean }): void,
} {
  const origin = origins.get(chatId);
  const messages = new Map<MessageId, AssistantMessageNode>();
  if (origin && (endpoint.type !== 'llama_cpp_browser' || !sameLocalModelBinding({ left: { endpoint, modelId }, right: { endpoint, modelId: origin.modelId } }) || !origin.isCurrent())) {
    if (!origin.isCurrent()) {
      invalidateHistoryProofs({ chatId });
    }
    invalidateOrigin({ origin });
  }
  return {
    recordAssistant({ messageId }) {
      const chat = getLiveChatById({ chatId });
      const node = chat === null || chat === undefined ? null : findNodeInBranch({ items: chat.root.items, targetId: messageId });
      if (node !== null) {
        switch (node.role) {
        case 'assistant': messages.set(messageId, node);
          break;
        case 'user': case 'system': case 'tool': break;
        default: {
          const exhaustive: never = node;
          throw new Error(String(exhaustive));
        }
        }
      }
    },
    finish({ persisted }) {
      if (!persisted || !origin || origins.get(chatId) !== origin || !origin.valid) {
        return;
      }
      if (!origin.isCurrent()) {
        invalidateHistoryProofs({ chatId });
        invalidateOrigin({ origin });
        return;
      }
      for (const [messageId, node] of messages) {
        origin.messages.set(messageId, chatModelBindingAssistantFingerprint({ node }));
      }
    },
  };
}

export const TEST_ONLY = {
  reset() {
    for (const input of chatLocalModelInputs.value.values()) {
      input.controller.abort();
    }
    chatLocalModelInputs.value = new Map();
    for (const chatId of [...proofs.keys()]) {
      invalidateHistoryProofs({ chatId });
    }
    for (const origin of origins.values()) {
      origin.stop();
    }
    origins.clear();
  },
};
