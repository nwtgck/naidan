import type {
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
} from "@/features/transformers-js/model-support-investigation/types";

export const DEFAULT_CANDIDATE_ATTEMPT_TIMEOUT_MS = 20 * 60 * 1000;

export class CandidateAttemptTimeoutError extends Error {
  readonly stage: ModelSupportInvestigationLoadAttemptStage;
  readonly events: ModelSupportInvestigationLoadAttemptEvent[];
  readonly timeoutMs: number;

  constructor({
    stage,
    events,
    timeoutMs,
  }: {
    stage: ModelSupportInvestigationLoadAttemptStage,
    events: ModelSupportInvestigationLoadAttemptEvent[],
    timeoutMs: number,
  }) {
    super(`Candidate attempt timed out after ${timeoutMs} ms at ${stage}`);
    this.name = "CandidateAttemptTimeoutError";
    this.stage = stage;
    this.events = events;
    this.timeoutMs = timeoutMs;
  }
}

export async function withCandidateAttemptTimeout<T>({
  operation,
  timeoutMs,
  timeoutError,
  onTimeout,
}: {
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => CandidateAttemptTimeoutError,
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
