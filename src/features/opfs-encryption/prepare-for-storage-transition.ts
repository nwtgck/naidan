import { nextTick } from 'vue';
import { promiseAllKeyed } from '@/utils/promise';

type SettledPreparationTask<T> =
  | { readonly state: 'completed'; readonly value: T }
  | { readonly cause: unknown; readonly state: 'failed' };

type OpfsTransitionPreparationLoaders = Readonly<{
  loadChatProcessing: () => Promise<typeof import('@/composables/chat/chat-scoped/chat-processing-abort')>;
  loadDebugHizoFS: () => Promise<typeof import('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench')>;
  loadDebugOpfsEncryption: () => Promise<typeof import('@/features/debug-opfs-encryption/composables/usePersistenceControlInspector')>;
  loadFileExplorer: () => Promise<typeof import('@/features/file-explorer/composables/useFileExplorerModal')>;
  loadFileExplorerClients: () => Promise<typeof import('@/features/file-explorer/worker/client-registry')>;
  loadWeshClients: () => Promise<typeof import('@/features/wesh/worker/client-registry')>;
}>;

async function settlePreparationTask<T>({ run }: {
  run: () => Promise<T> | T;
}): Promise<SettledPreparationTask<T>> {
  try {
    return { state: 'completed', value: await run() };
  } catch (cause: unknown) {
    return { cause, state: 'failed' };
  }
}

async function runLoadedPreparationTask<T>({ loaded, run }: {
  loaded: SettledPreparationTask<T>;
  run: ({ loaded }: { loaded: T }) => Promise<void> | void;
}): Promise<SettledPreparationTask<void>> {
  switch (loaded.state) {
  case 'completed': return await settlePreparationTask({
    run: async () => await run({ loaded: loaded.value }),
  });
  case 'failed': return loaded;
  default: return loaded satisfies never;
  }
}

function preparationTaskFailures({ tasks }: {
  tasks: readonly SettledPreparationTask<unknown>[];
}): readonly unknown[] {
  return tasks.flatMap(task => {
    switch (task.state) {
    case 'completed': return [];
    case 'failed': return [task.cause];
    default: return task satisfies never;
    }
  });
}

function throwPreparationFailures({ failures }: {
  failures: readonly unknown[];
}): void {
  const [failure] = failures;
  if (failure === undefined && failures.length === 0) return;
  if (failures.length === 1) throw failure;
  throw new AggregateError(failures, 'Multiple OPFS transition application preparations failed');
}

const browserLoaders: OpfsTransitionPreparationLoaders = {
  loadChatProcessing: async () => await import('@/composables/chat/chat-scoped/chat-processing-abort'),
  loadDebugHizoFS: async () => await import('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench'),
  loadDebugOpfsEncryption: async () => await import('@/features/debug-opfs-encryption/composables/usePersistenceControlInspector'),
  loadFileExplorer: async () => await import('@/features/file-explorer/composables/useFileExplorerModal'),
  loadFileExplorerClients: async () => await import('@/features/file-explorer/worker/client-registry'),
  loadWeshClients: async () => await import('@/features/wesh/worker/client-registry'),
};

/**
 * Stops same-tab work that may retain native OPFS handles or schedule storage
 * writes after the provider session has been suspended.
 *
 * Other tabs run the same preflight after receiving the transition-started
 * event, release their shared OPFS session lock, and remain blocked until the
 * initiator reports completion or rollback. StorageService invokes this
 * function through the registered application preparation boundary before
 * any public transition announces or mutates persistence authority.
 */
export async function prepareForOpfsEncryptionTransition(): Promise<void> {
  await prepareForOpfsEncryptionTransitionWith({ loaders: browserLoaders });
}

async function prepareForOpfsEncryptionTransitionWith({ loaders }: {
  loaders: OpfsTransitionPreparationLoaders;
}): Promise<void> {
  const loaded = await promiseAllKeyed({
    chatProcessing: settlePreparationTask({ run: loaders.loadChatProcessing }),
    debugHizoFS: settlePreparationTask({ run: loaders.loadDebugHizoFS }),
    debugOpfsEncryption: settlePreparationTask({ run: loaders.loadDebugOpfsEncryption }),
    fileExplorer: settlePreparationTask({ run: loaders.loadFileExplorer }),
    fileExplorerClients: settlePreparationTask({ run: loaders.loadFileExplorerClients }),
    weshClients: settlePreparationTask({ run: loaders.loadWeshClients }),
  });
  const closures = await promiseAllKeyed({
    chatProcessing: runLoadedPreparationTask({
      loaded: loaded.chatProcessing,
      run: ({ loaded: module }) => module.abortAllChatProcessingForStorageTransition(),
    }),
    debugHizoFS: runLoadedPreparationTask({
      loaded: loaded.debugHizoFS,
      run: ({ loaded: module }) => module.useDebugHizoFSWorkbench().closeDebugHizoFSWorkbench(),
    }),
    debugOpfsEncryption: runLoadedPreparationTask({
      loaded: loaded.debugOpfsEncryption,
      run: ({ loaded: module }) => module.usePersistenceControlInspector().closePersistenceControlInspector(),
    }),
    fileExplorer: runLoadedPreparationTask({
      loaded: loaded.fileExplorer,
      run: ({ loaded: module }) => module.useFileExplorerModal().closeFileExplorer(),
    }),
  });
  const tick = await settlePreparationTask({ run: async () => await nextTick() });
  const disposals = await promiseAllKeyed({
    fileExplorerClients: runLoadedPreparationTask({
      loaded: loaded.fileExplorerClients,
      run: async ({ loaded: module }) => await module.disposeAllFileExplorerWorkerClientsForStorageTransition(),
    }),
    weshClients: runLoadedPreparationTask({
      loaded: loaded.weshClients,
      run: async ({ loaded: module }) => await module.disposeAllWeshWorkerClientsForStorageTransition(),
    }),
  });

  throwPreparationFailures({
    failures: preparationTaskFailures({
      tasks: [
        closures.chatProcessing,
        closures.debugHizoFS,
        closures.debugOpfsEncryption,
        closures.fileExplorer,
        tick,
        disposals.fileExplorerClients,
        disposals.weshClients,
      ],
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  browserLoaders,
  prepareForOpfsEncryptionTransitionWith,
};
