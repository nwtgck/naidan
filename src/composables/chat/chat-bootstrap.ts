let installedCleanup: (() => void) | undefined;

export function installChatBootstrap({
  registerBeforeUnload,
  subscribeModelList,
}: {
  registerBeforeUnload: (_args: Record<never, never>) => (() => void) | undefined;
  subscribeModelList: (_args: Record<never, never>) => (() => void) | undefined;
}) {
  installedCleanup?.();

  const beforeUnloadCleanup = registerBeforeUnload({});
  const modelListCleanup = subscribeModelList({});

  installedCleanup = () => {
    beforeUnloadCleanup?.();
    modelListCleanup?.();
  };
}
