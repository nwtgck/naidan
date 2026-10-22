import { onScopeDispose, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { useAppEntry, type ModelLaunchAppContext } from '@/composables/useAppEntry';
import { useAppPresentation, isAppInteractionEnabled } from '@/composables/useAppPresentation';
import { storageService } from '@/00-storage/service';
import { loadData, registerLiveInstance } from '@/composables/chat/global/chat-core-singletons';
import type { Chat } from '@/01-models/types';
import { idToRaw, toChatId } from '@/01-models/ids';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { destinationKey, hostModelRoot } from '@/features/llama-cpp-browser/runtime/model-destination';
import { formatHostModelId } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { modelLaunchChatGroupName, modelLaunchChoices, ModelLaunchTargetError, rememberLaunchCatalog, resolveModelLaunchConfiguration, confirmModelLaunchConfiguration, sameLaunchTarget } from '@/features/llama-cpp-browser/model-launch/target';
import { readModelLaunchHistoryReservation, reserveModelLaunchHistory, modelLaunchHistoryKey } from '@/features/llama-cpp-browser/model-launch/history';
import { isModelLaunchTargetReady } from '@/features/llama-cpp-browser/model-launch/readiness';
import { consumeModelLaunchSession, findModelLaunchSession, rememberModelLaunchSession, type ModelLaunchSession } from '@/features/llama-cpp-browser/model-launch/session';
import { modelLaunchCommand, modelLaunchEntryState, setModelLaunchEntryState, type ModelLaunchCommand, type ModelLaunchStartRequest, type ModelLaunchDestinationAuthorization } from '@/features/llama-cpp-browser/model-launch/entry-state';

type LaunchOperation = {
  id: symbol, request: ModelLaunchStartRequest, requestKey: string, context: ModelLaunchAppContext,
  controller: AbortController, isStorageCurrent(): boolean, defaults: ModelLaunchSession['defaults'],
  catalog: RepositoryCatalog | undefined, target: ModelLaunchTarget | undefined,
  reservation: ReturnType<typeof reserveModelLaunchHistory> | undefined,
  expectedRoot: FileSystemDirectoryHandle | undefined, authorization: Promise<ModelLaunchDestinationAuthorization> | undefined,
};

/** Route observation only retires operations; explicit bridge actions start IO. */
export function useModelLaunchCoordinator(): void {
  const router = useRouter(), settingsApi = useSettings(), entry = useAppEntry();
  const { appInteraction } = useAppPresentation();
  const queue = getDownloadQueue();
  let active: LaunchOperation | undefined, disposed = false;
  const isCurrent = ({ operation }: { operation: LaunchOperation }) => !disposed && active === operation
    && !operation.controller.signal.aborted && operation.isStorageCurrent() && operation.context.isCurrent();
  function fail({ operation, error }: { operation: LaunchOperation, error: unknown }): void {
    if (isCurrent({ operation })) {
      setModelLaunchEntryState({ state: { status: 'failed', operation: operation.id, input: operation.request.input, problem: error instanceof ModelLaunchTargetError ? error.problem : 'failed' } });
    }
  }
  async function authorize({ operation, authorization }: { operation: LaunchOperation, authorization: Promise<ModelLaunchDestinationAuthorization> | undefined }): Promise<void> {
    const destination = operation.request.destination;
    let result: ModelLaunchDestinationAuthorization;
    if (authorization === undefined) {
      switch (destination.kind) {
      case 'opfs': result = { destination, expectedRoot: undefined };
        break;
      case 'host': result = { destination, expectedRoot: await hostModelRoot({ destination, mode: 'readwrite' }) };
        break;
      default: {
        const exhaustive: never = destination;
        throw new Error(String(exhaustive));
      }
      }
    } else {
      result = await authorization;
    }
    if (destinationKey({ destination: result.destination }) !== destinationKey({ destination })
      || operation.expectedRoot !== undefined && (result.expectedRoot === undefined || !await result.expectedRoot.isSameEntry(operation.expectedRoot))) {
      throw new Error('The model destination changed');
    }
    operation.expectedRoot = result.expectedRoot;
  }
  async function reusableChat({ session }: { session: ModelLaunchSession }): Promise<Chat | undefined> {
    const chat = await storageService.loadChat({ id: session.chatId });
    const launch = storageService.getModelLaunch({ chatId: session.chatId });
    const chatGroup = chat?.groupId == null ? undefined : await storageService.loadChatGroup({ id: chat.groupId });
    if (session.consumed || !session.isStorageCurrent() || chat === null || chat.root.items.length > 0
      || chat.endpoint !== undefined || chat.modelId !== undefined || launch?.phase !== 'active' || launch.chatGroupId !== chat.groupId
      || !sameLaunchTarget({ left: launch.target, right: session.target }) || launch.effectiveModelId !== session.effectiveModelId
      || destinationKey({ destination: launch.destination }) !== destinationKey({ destination: session.destination })
      || chatGroup?.endpoint?.type !== 'llama_cpp_browser' || chatGroup.modelId !== session.effectiveModelId) {
      consumeModelLaunchSession({ chatId: session.chatId });
      return undefined;
    }
    return chat;
  }
  async function openChat({ operation, chat, session }: { operation: LaunchOperation, chat: Chat, session: ModelLaunchSession }): Promise<void> {
    if (!isCurrent({ operation })) {
      return;
    }
    registerLiveInstance({ chat });
    await loadData();
    if (!isCurrent({ operation })) {
      return;
    }
    const path = `/chat/${idToRaw({ id: chat.id })}`;
    if (!entry.prepareModelLaunchHandoff({ owner: operation.context.owner, chatPath: path })) {
      return;
    }
    const location = {
      path,
      query: {},
      hash: '',
      state: {
        [modelLaunchHistoryKey]: false,
      },
    };
    let failure: Awaited<ReturnType<typeof router.push>>;
    const source = operation.request.source;
    switch (source) {
    case 'model-url': failure = await router.replace(location);
      break;
    case 'home': case 'catalog': case 'hugging-face': failure = await router.push(location);
      break;
    default: {
      const exhaustive: never = source;
      throw new Error(String(exhaustive));
    }
    }
    if (!isCurrent({ operation })) {
      return;
    }
    if (failure || router.currentRoute.value.path !== path) {
      throw new Error('Could not open the model chat');
    }
    setModelLaunchEntryState({ state: { status: 'idle' } });
    const ready = await isModelLaunchTargetReady({ target: session.target, destination: session.destination, effectiveModelId: session.effectiveModelId });
    if (!isCurrent({ operation }) || ready) {
      return;
    }
    queue.enqueue({
      key: selectionKey({ selection: session.target.selection }),
      repository: session.target.selection.repository,
      source: 'repository',
      destination: session.destination,
      expectedRoot: session.expectedRoot,
      prepare: async () => session.target.selection,
    });
  }
  async function saveAndOpen({ operation }: { operation: LaunchOperation }): Promise<void> {
    const target = operation.target;
    if (target === undefined || !isCurrent({ operation })) {
      return;
    }
    setModelLaunchEntryState({ state: { status: 'checking', operation: operation.id, input: operation.request.input, phase: 'opening-chat' } });
    const location = JSON.stringify([operation.context.homeOriginId, operation.requestKey]);
    if (operation.reservation === undefined) {
      const prior = readModelLaunchHistoryReservation({ history: router.options.history, location });
      if (prior !== undefined) {
        const meta = await storageService.loadChatMeta({ id: prior.chatId });
        if (meta === null || storageService.getModelLaunch({ chatId: prior.chatId }) === undefined || operation.context.homeOriginId !== undefined && storageService.getModelLaunch({ chatId: prior.chatId })?.phase === 'active') {
          if (meta === null && (await storageService.loadChatContent({ id: prior.chatId }) !== null
            || (await storageService.loadHierarchy()).items.some(item => {
              switch (item.type) {
              case 'chat': return item.id === prior.chatId;
              case 'chat_group': return item.chat_ids.includes(prior.chatId);
              default: {
                const exhaustive: never = item;
                throw new Error(String(exhaustive));
              }
              }
            }))) {
            throw new Error('The previous model launch is incomplete');
          }
          if (!isCurrent({ operation })) {
            return;
          }
          const history = router.options.history;
          history.replace(history.location, { ...history.state, [modelLaunchHistoryKey]: false });
        }
      }
      if (!isCurrent({ operation })) {
        return;
      }
      operation.reservation = reserveModelLaunchHistory({ history: router.options.history, location, fallback: undefined });
    }
    const destination = operation.request.destination;
    let effectiveModelId: string;
    switch (destination.kind) {
    case 'opfs': effectiveModelId = target.modelId;
      break;
    case 'host': effectiveModelId = formatHostModelId({
      directoryId: destination.directoryId,
      repository: target.selection.repository,
      primaryRelativePath: target.mainFilePath,
      directories: await storageService.loadHostModelDirectories(),
    });
      break;
    default: {
      const exhaustive: never = destination;
      throw new Error(String(exhaustive));
    }
    }
    if (!isCurrent({ operation })) {
      return;
    }
    const chat = await storageService.prepareModelLaunchChat({
      signal: operation.controller.signal,
      request: {
        ...operation.reservation,
        input: operation.request.input,
        requestedVariant: operation.request.requestedVariant,
        target,
        destination,
        effectiveModelId,
        chatGroupName: modelLaunchChatGroupName({ target }),
        titleGeneration: settingsApi.settings.value.titleGeneration,
        mode: storageService.getModelLaunch({ chatId: operation.reservation.chatId }) === undefined ? 'create' : 'resume',
        expectedTarget: undefined,
      },
    });
    const launch = storageService.getModelLaunch({ chatId: chat.id });
    if (launch === undefined) {
      throw new Error('The model launch was not saved');
    }
    const session: ModelLaunchSession = {
      chatId: chat.id,
      homeOriginId: operation.context.homeOriginId,
      requestKey: operation.requestKey,
      target: launch.target,
      destination: launch.destination,
      effectiveModelId: launch.effectiveModelId,
      expectedRoot: operation.expectedRoot,
      isStorageCurrent: operation.isStorageCurrent,
      defaults: operation.defaults,
      defaultAttempted: false,
      consumed: false,
    };
    rememberModelLaunchSession({ session });
    await openChat({ operation, chat, session });
  }
  async function resolveAndStart({ operation }: { operation: LaunchOperation }): Promise<void> {
    try {
      await authorize({ operation, authorization: operation.authorization });
      if (!isCurrent({ operation })) {
        return;
      }
      if (operation.target !== undefined) {
        await saveAndOpen({ operation });
        return;
      }
      const origin = operation.context.homeOriginId;
      const pinned = origin === undefined ? undefined : findModelLaunchSession({ homeOriginId: origin, requestKey: operation.requestKey });
      if (pinned !== undefined) {
        const chat = await reusableChat({ session: pinned });
        if (!isCurrent({ operation })) {
          return;
        }
        if (chat !== undefined) {
          if (pinned.expectedRoot !== undefined && (operation.expectedRoot === undefined || !await operation.expectedRoot.isSameEntry(pinned.expectedRoot))) {
            throw new Error('The model destination changed');
          }
          await openChat({ operation, chat, session: pinned });
          return;
        }
      }
      const location = JSON.stringify([operation.context.homeOriginId, operation.requestKey]);
      const prior = readModelLaunchHistoryReservation({ history: router.options.history, location });
      if (prior !== undefined) {
        const saved = storageService.getModelLaunch({ chatId: prior.chatId });
        if (!isCurrent({ operation })) {
          return;
        }
        if (saved !== undefined && (saved.phase === 'reserved' || saved.phase === 'active' && origin === undefined)
          && destinationKey({ destination: saved.destination }) === destinationKey({ destination: operation.request.destination })) {
          operation.reservation = prior;
          operation.target = saved.target;
          operation.defaults = Promise.resolve(undefined);
          await saveAndOpen({ operation });
          return;
        }
      }
      const catalog = operation.catalog ?? structuredClone(await getMetadataSession().inspect({ input: parseRepository({ input: operation.request.input }).repository, signal: operation.controller.signal, freshness: 'reuse' }));
      if (!isCurrent({ operation })) {
        return;
      }
      operation.catalog = catalog;
      rememberLaunchCatalog({ catalog });
      let requestedVariant = operation.request.requestedVariant;
      if (requestedVariant === undefined && operation.context.routePath === '/') {
        const source = operation.request.source;
        switch (source) {
        case 'model-url':
          // Start can precede the preview metadata; use the same first real choice.
          requestedVariant = modelLaunchChoices({ catalog })[0]?.primaryRelativePath;
          break;
        case 'home': case 'catalog': case 'hugging-face': break;
        default: {
          const exhaustive: never = source;
          throw new Error(String(exhaustive));
        }
        }
      }
      const configuration = resolveModelLaunchConfiguration({ input: operation.request.input, requestedVariant, catalog, multimodal: operation.request.multimodal });
      switch (configuration.status) {
      case 'invalid': throw new ModelLaunchTargetError({ problem: configuration.problem });
      case 'needs-selection': {
        const { status: _status, ...selection } = configuration;
        setModelLaunchEntryState({ state: { status: 'needs-selection', operation: operation.id, input: operation.request.input, ...selection } });
        return;
      }
      case 'resolved': operation.target = configuration.target;
        break;
      default: {
        const exhaustive: never = configuration;
        throw new Error(String(exhaustive));
      }
      }
      await saveAndOpen({ operation });
    } catch (error) {
      fail({ operation, error });
    }
  }
  function handleCommand({ command }: { command: ModelLaunchCommand }): void {
    switch (command.kind) {
    case 'start': {
      active?.controller.abort();
      if (!settingsApi.initialized.value || entry.interaction.value !== 'ready' || !isAppInteractionEnabled({ interaction: appInteraction.value })) {
        setModelLaunchEntryState({ state: { status: 'idle' } });
        return;
      }
      const context = entry.captureModelLaunchContext();
      if (command.context !== undefined && (!command.context.isCurrent() || command.context.owner !== context.owner)) {
        setModelLaunchEntryState({ state: { status: 'idle' } });
        return;
      }
      const request = command.request;
      const operation: LaunchOperation = {
        id: command.operation,
        request,
        requestKey: '',
        context,
        controller: new AbortController(),
        isStorageCurrent: storageService.captureModelLaunchStorage(),
        defaults: command.context?.defaults ?? Promise.resolve(undefined),
        catalog: undefined,
        target: undefined,
        reservation: undefined,
        expectedRoot: undefined,
        authorization: command.authorization,
      };
      active = operation;
      try {
        if (!request.input || request.input.length > 4096) {
          throw new ModelLaunchTargetError({ problem: 'invalid-input' });
        }
        const repository = parseRepository({ input: request.input }).repository;
        const requestedVariant = request.requestedVariant?.trim() || undefined;
        operation.request = { ...request, requestedVariant };
        operation.requestKey = JSON.stringify([repository, requestedVariant, request.multimodal, destinationKey({ destination: request.destination })]);
        void resolveAndStart({ operation });
      } catch (error) {
        fail({ operation, error });
      }
      return;
    }
    case 'confirm': {
      const operation = active, state = modelLaunchEntryState.value;
      if (operation?.id !== command.operation || !isCurrent({ operation }) || operation.catalog === undefined || state.status !== 'needs-selection') {
        return;
      }
      if (!state.mainChoices.some(choice => choice.path === command.mainFilePath)
        || command.companionFilePath !== undefined && !state.companionChoices.some(choice => choice.path === command.companionFilePath)) {
        return;
      }
      try {
        operation.target = confirmModelLaunchConfiguration({ catalog: operation.catalog, mainFilePath: command.mainFilePath, companionFilePath: command.companionFilePath, multimodal: operation.request.multimodal });
        setModelLaunchEntryState({ state: { status: 'checking', operation: operation.id, input: operation.request.input, phase: 'opening-chat' } });
        void authorize({ operation, authorization: command.authorization }).then(() => saveAndOpen({ operation })).catch(error => fail({ operation, error }));
      } catch (error) {
        fail({ operation, error });
      }
      return;
    }
    case 'retry': {
      const operation = active;
      if (operation?.id === command.operation && isCurrent({ operation })) {
        setModelLaunchEntryState({ state: { status: 'checking', operation: operation.id, input: operation.request.input, phase: operation.target === undefined ? 'metadata' : 'opening-chat' } });
        void resolveAndStart({ operation });
      }
      return;
    }
    case 'retire': if (active?.id === command.operation) {
      active.controller.abort();
    }
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(String(exhaustive));
    }
    }
  }
  watch(modelLaunchCommand, command => {
    if (command !== undefined) {
      handleCommand({ command });
    }
  }, { immediate: true, flush: 'sync' });
  watch([() => router.currentRoute.value.fullPath, () => entry.intent.value, settingsApi.settings], () => {
    if (active !== undefined && !isCurrent({ operation: active })) {
      active.controller.abort();
      if (modelLaunchEntryState.value.status !== 'idle' && modelLaunchEntryState.value.operation === active.id) {
        setModelLaunchEntryState({ state: { status: 'idle' } });
      }
    }
  });
  const unsubscribe = storageService.subscribeToChanges({
    listener: ({ event }) => {
      switch (event.type) {
      case 'chat_content': consumeModelLaunchSession({ chatId: toChatId({ raw: event.id }) });
        break;
      case 'chat_content_generation': {
        const status = event.status;
        switch (status) {
        case 'started': consumeModelLaunchSession({ chatId: toChatId({ raw: event.id }) });
          break;
        case 'stopped': case 'abort_request': break;
        default: {
          const exhaustive: never = status;
          throw new Error(String(exhaustive));
        }
        }
        break;
      }
      case 'chat_meta_and_chat_group': case 'settings': case 'binary_objects': case 'migration': case 'naidan_rpc_registry': break;
      default: {
        const exhaustive: never = event;
        throw new Error(String(exhaustive));
      }
      }
    },
  });
  onScopeDispose(() => {
    disposed = true;
    active?.controller.abort();
    unsubscribe();
  });
}

export const TEST_ONLY = {
};
