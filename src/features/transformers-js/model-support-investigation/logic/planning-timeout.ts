import type { ModelSupportInvestigationStepId } from "@/features/transformers-js/model-support-investigation/types";

export const DEFAULT_PLANNING_TIMEOUT_MS = 5 * 60 * 1000;

export type ModelSupportInvestigationPlanningStage = "worker-start" | ModelSupportInvestigationStepId;

export class PlanningTimeoutError extends Error {
  readonly stage: ModelSupportInvestigationPlanningStage;
  readonly timeoutMs: number;

  constructor({ stage, timeoutMs }: {
    stage: ModelSupportInvestigationPlanningStage,
    timeoutMs: number,
  }) {
    super(`Investigation planning timed out after ${timeoutMs} ms at ${stage}`);
    this.name = "PlanningTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export async function withPlanningTimeout<T>({
  operation,
  timeoutMs,
  timeoutError,
  onTimeout,
}: {
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => PlanningTimeoutError,
  onTimeout: () => void,
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
