import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';

export type ModelSupportInvestigationTargetExecutionStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'interrupted';

export interface ModelSupportInvestigationTargetExecution {
  target: string;
  status: ModelSupportInvestigationTargetExecutionStatus;
  run: ModelSupportInvestigationRun | undefined;
  error: string | undefined;
}

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInvestigationTargetsSequentially({
  targets,
  runTarget,
  onUpdate,
  shouldInterrupt,
  takeSkipRequest,
  recoverRunAfterError = () => undefined,
}: {
  targets: readonly string[];
  runTarget: ({ target }: { target: string }) => Promise<ModelSupportInvestigationRun>;
  onUpdate: ({ executions }: { executions: readonly ModelSupportInvestigationTargetExecution[] }) => void;
  shouldInterrupt: () => boolean;
  takeSkipRequest: ({ target }: { target: string }) => boolean;
  recoverRunAfterError?: ({ target, error }: { target: string; error: unknown }) => ModelSupportInvestigationRun | undefined;
}): Promise<ModelSupportInvestigationTargetExecution[]> {
  const executions: ModelSupportInvestigationTargetExecution[] = targets.map(target => ({
    target,
    status: 'pending',
    run: undefined,
    error: undefined,
  }));
  const publish = (): void => onUpdate({ executions: structuredClone(executions) });
  publish();

  for (const [index, target] of targets.entries()) {
    if (shouldInterrupt()) break;
    const execution = executions[index]!;
    execution.status = 'running';
    publish();
    try {
      const run = await runTarget({ target });
      execution.run = structuredClone(run);
      if (takeSkipRequest({ target })) {
        execution.status = 'skipped';
        execution.error = run.error;
      } else {
        execution.status = run.status;
        execution.error = run.error;
      }
    } catch (error) {
      const partialRun = recoverRunAfterError({ target, error });
      execution.run = partialRun === undefined ? undefined : structuredClone(partialRun);
      if (shouldInterrupt()) {
        execution.status = 'interrupted';
        execution.error = errorMessage({ error });
        publish();
        break;
      }
      if (takeSkipRequest({ target })) {
        execution.status = 'skipped';
        execution.error = errorMessage({ error });
      } else {
        execution.status = 'failed';
        execution.error = errorMessage({ error });
      }
    }
    publish();
  }

  return executions;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
