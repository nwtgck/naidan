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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
