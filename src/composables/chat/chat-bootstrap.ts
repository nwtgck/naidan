let installedCleanup: (() => void) | undefined;

export function installChatBootstrap({
  registerBeforeUnload,
  subscribeModelList,
}: {
  registerBeforeUnload: () => (() => void) | undefined,
  subscribeModelList: () => (() => void) | undefined,
}) {
  installedCleanup?.();

  const beforeUnloadCleanup = registerBeforeUnload();
  const modelListCleanup = subscribeModelList();

  installedCleanup = () => {
    beforeUnloadCleanup?.();
    modelListCleanup?.();
  };
}
