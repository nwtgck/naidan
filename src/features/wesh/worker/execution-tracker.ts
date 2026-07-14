import {
  weshWorkerExecutionSummarySchema,
  type IWeshWorker,
  type WeshWorkerExecutionSummary,
} from './types';

const FORCED_WESH_EXECUTION_EXIT_CODE = 130;

type WeshExecutionRemote = Pick<
  IWeshWorker,
  'awaitExecution' | 'interruptExecution' | 'disposeExecution'
>;

type WeshExecutionRecord<TRuntime> = {
  readonly clientExecutionId: string;
  readonly remoteExecutionId: string;
  readonly runtime: TRuntime;
  readonly forcedCompletion: ReturnType<
    typeof Promise.withResolvers<WeshWorkerExecutionSummary>
  >;
  completion: Promise<WeshWorkerExecutionSummary> | undefined;
  retired: boolean;
};

export function createWeshWorkerExecutionTracker<TRuntime>({
  getRemote,
}: {
  readonly getRemote: ({ runtime }: { readonly runtime: TRuntime }) => WeshExecutionRemote;
}) {
  let nextClientExecutionId = 1;
  const executions = new Map<string, WeshExecutionRecord<TRuntime>>();
  const executionsByRuntime = new Map<TRuntime, Set<WeshExecutionRecord<TRuntime>>>();

  const getExecution = ({ executionId }: { readonly executionId: string }) => {
    const execution = executions.get(executionId);
    if (execution === undefined) {
      throw new Error(`Unknown Wesh client execution: ${executionId}`);
    }
    return execution;
  };

  const removeExecution = ({ execution }: {
    readonly execution: WeshExecutionRecord<TRuntime>;
  }) => {
    executions.delete(execution.clientExecutionId);
    const runtimeExecutions = executionsByRuntime.get(execution.runtime);
    runtimeExecutions?.delete(execution);
    if (runtimeExecutions?.size === 0) {
      executionsByRuntime.delete(execution.runtime);
    }
  };

  const awaitExecution = ({ executionId }: { readonly executionId: string }) => {
    const execution = getExecution({ executionId });
    if (execution.retired) {
      return execution.forcedCompletion.promise;
    }
    execution.completion ??= Promise.race([
      Promise.resolve().then(async () => {
        const response = await getRemote({ runtime: execution.runtime }).awaitExecution({
          request: { executionId: execution.remoteExecutionId },
        });
        return weshWorkerExecutionSummarySchema.parse(response);
      }),
      execution.forcedCompletion.promise,
    ]);
    return execution.completion;
  };

  const forceCompleteRuntime = ({ runtime }: { readonly runtime: TRuntime }) => {
    const runtimeExecutions = executionsByRuntime.get(runtime);
    if (runtimeExecutions === undefined) {
      return;
    }
    const summary = weshWorkerExecutionSummarySchema.parse({
      exitCode: FORCED_WESH_EXECUTION_EXIT_CODE,
    });
    for (const execution of runtimeExecutions) {
      execution.retired = true;
      // Resolve the client-owned completion before terminating the Worker. A
      // Comlink promise can otherwise remain pending forever after its transport
      // disappears, which would hang callers that await completion after cancel.
      execution.forcedCompletion.resolve(summary);
    }
  };

  return {
    registerExecution({
      runtime,
      remoteExecutionId,
    }: {
      readonly runtime: TRuntime;
      readonly remoteExecutionId: string;
    }) {
      const clientExecutionId = `wesh-client-exec-${nextClientExecutionId}`;
      nextClientExecutionId += 1;
      const forcedCompletion = Promise.withResolvers<WeshWorkerExecutionSummary>();
      const execution: WeshExecutionRecord<TRuntime> = {
        clientExecutionId,
        remoteExecutionId,
        runtime,
        forcedCompletion,
        completion: undefined,
        retired: false,
      };
      executions.set(clientExecutionId, execution);
      const runtimeExecutions = executionsByRuntime.get(runtime) ?? new Set();
      runtimeExecutions.add(execution);
      executionsByRuntime.set(runtime, runtimeExecutions);
      return clientExecutionId;
    },

    awaitExecution,

    async interruptExecution({ executionId }: { readonly executionId: string }) {
      const execution = getExecution({ executionId });
      if (execution.retired) {
        return false;
      }
      return getRemote({ runtime: execution.runtime }).interruptExecution({
        request: { executionId: execution.remoteExecutionId },
      });
    },

    async disposeExecution({ executionId }: { readonly executionId: string }) {
      const execution = getExecution({ executionId });
      try {
        if (!execution.retired) {
          await getRemote({ runtime: execution.runtime }).disposeExecution({
            request: { executionId: execution.remoteExecutionId },
          });
        }
      } finally {
        removeExecution({ execution });
      }
    },

    getRuntime({ executionId }: { readonly executionId: string }) {
      return getExecution({ executionId }).runtime;
    },

    forceCompleteRuntime,

    forceCompleteAll() {
      for (const runtime of executionsByRuntime.keys()) {
        forceCompleteRuntime({ runtime });
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  FORCED_WESH_EXECUTION_EXIT_CODE,
};
