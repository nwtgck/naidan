type ChatBootstrapState = {
  beforeUnloadHandler: (() => void) | undefined;
  unsubscribeModelList: (() => void) | undefined;
};

const CHAT_BOOTSTRAP_KEY = '__naidan_use_chat_bootstrap__';

function getBootstrapState(): ChatBootstrapState {
  const globalState = globalThis as typeof globalThis & {
    [CHAT_BOOTSTRAP_KEY]?: ChatBootstrapState;
  };
  if (!globalState[CHAT_BOOTSTRAP_KEY]) {
    globalState[CHAT_BOOTSTRAP_KEY] = {
      beforeUnloadHandler: undefined,
      unsubscribeModelList: undefined,
    };
  }
  return globalState[CHAT_BOOTSTRAP_KEY]!;
}

export function installChatBootstrap({
  registerBeforeUnload,
  subscribeModelList,
}: {
  registerBeforeUnload: (_args: Record<never, never>) => (() => void) | undefined;
  subscribeModelList: (_args: Record<never, never>) => (() => void) | undefined;
}) {
  const state = getBootstrapState();

  state.beforeUnloadHandler?.();
  state.beforeUnloadHandler = registerBeforeUnload({});

  state.unsubscribeModelList?.();
  state.unsubscribeModelList = subscribeModelList({});
}
