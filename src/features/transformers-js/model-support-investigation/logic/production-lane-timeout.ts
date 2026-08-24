export const DEFAULT_PRODUCTION_LANE_TIMEOUT_MS = 30 * 60 * 1000;

export type ModelSupportInvestigationProductionLaneStage =
  | "worker-start"
  | "model-load"
  | "first-turn"
  | "continuity"
  | "tool-result-continuation"
  | "reasoning-differential"
  | "multimodal"
  | "complete";

export class ProductionLaneTimeoutError extends Error {
  readonly stage: ModelSupportInvestigationProductionLaneStage;
  readonly timeoutMs: number;

  constructor({ stage, timeoutMs }: {
    stage: ModelSupportInvestigationProductionLaneStage,
    timeoutMs: number,
  }) {
    super(`Production Lane timed out after ${timeoutMs} ms at ${stage}`);
    this.name = "ProductionLaneTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export async function withProductionLaneTimeout<T>({
  operation,
  timeoutMs,
  timeoutError,
  onTimeout,
}: {
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => ProductionLaneTimeoutError,
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

export const TEST_ONLY = {
};
