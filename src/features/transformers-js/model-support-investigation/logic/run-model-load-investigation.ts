import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationGenerationAutoClassName,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
} from "@/features/transformers-js/model-support-investigation/types";
import { selectGenerationAutoClass } from "@/features/transformers-js/model-support-investigation/logic/select-generation-auto-class";
import { CandidateAttemptTimeoutError } from "@/features/transformers-js/model-support-investigation/logic/candidate-attempt-timeout";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

function updateLoadingStep({ run, status, detail }: {
  run: ModelSupportInvestigationRun,
  status: ModelSupportInvestigationStep["status"],
  detail: string,
}): void {
  run.steps = run.steps.map((step) => {
    switch (step.id) {
    case "loading-investigation":
      return { ...step, status, detail };
    case "lane-comparison":
      return step;
    case "runtime-assets":
    case "repository-information":
    case "existing-model-data":
    case "model-declarations":
    case "template-behavior":
    case "model-file-plan":
    case "evidence-export":
      return step;
    default: {
      const _ex: never = step.id;
      return _ex;
    }
    }
  });
}

function appendError({ existing, detail }: { existing: string | undefined, detail: string }): string {
  return existing === undefined ? detail : `${existing}; ${detail}`;
}

function unexpectedAttempt({
  candidate,
  autoClass,
  repositoryRevision,
  error,
  now,
  createAttemptId,
}: {
  candidate: ModelSupportInvestigationCandidateFilePlan,
  autoClass: ModelSupportInvestigationGenerationAutoClassName,
  repositoryRevision: string,
  error: unknown,
  now: () => string,
  createAttemptId: () => string,
}): ModelSupportInvestigationLoadAttempt {
  const startedAt = now();
  const errorRecord = serializeInvestigationError({ error });
  const timeout = error instanceof CandidateAttemptTimeoutError ? error : undefined;
  const failureStage = timeout?.stage ?? "worker-start";
  const events = timeout === undefined
    ? [{
      stage: failureStage,
      status: "failed" as const,
      detail: `${candidate.candidateId}: ${errorRecord.message}`,
      at: startedAt,
    }]
    : [...timeout.events, {
      stage: failureStage,
      status: "failed" as const,
      detail: `${candidate.candidateId}: ${errorRecord.message}`,
      at: now(),
    }];
  return {
    attemptId: createAttemptId(),
    candidateId: candidate.candidateId,
    device: candidate.device,
    dtype: candidate.dtype,
    autoClass,
    resolvedRevision: repositoryRevision,
    startedAt,
    completedAt: now(),
    status: "failed",
    failureStage,
    events,
    inputTokenCount: undefined,
    inputTokenIds: [],
    inputTensors: [],
    loadedModel: undefined,
    generatedTokenIds: [],
    generatedText: undefined,
    naturalGeneration: undefined,
    toolProtocolProbe: undefined,
    modelType: undefined,
    error: errorRecord,
  };
}

export async function runModelLoadInvestigation({
  partialRun,
  runAttempt,
  onEvent,
  now,
  createAttemptId,
}: {
  partialRun: ModelSupportInvestigationRun,
  runAttempt: ({ candidate, autoClass }: {
    candidate: ModelSupportInvestigationCandidateFilePlan,
    autoClass: ModelSupportInvestigationGenerationAutoClassName,
  }) => Promise<ModelSupportInvestigationLoadAttempt>,
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  now: () => string,
  createAttemptId: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const run: ModelSupportInvestigationRun = {
    ...partialRun,
    scope: "partial-runtime-repository-cache-declarations-template-model-files-load",
    loadAttempts: [...partialRun.loadAttempts],
  };
  const emit = ({ status, detail }: {
    status: ModelSupportInvestigationStep["status"],
    detail: string,
  }): void => {
    updateLoadingStep({ run, status, detail });
    onEvent({ event: { stepId: "loading-investigation", status, detail } });
  };

  const { repository, declarations, modelFilePlan } = run;
  if (repository === undefined || declarations === undefined || modelFilePlan === undefined) {
    const missing = [
      repository === undefined ? "repository" : undefined,
      declarations === undefined ? "declarations" : undefined,
      modelFilePlan === undefined ? "model file plan" : undefined,
    ].filter((value): value is string => value !== undefined);
    const detail = `Blocked because ${missing.join(", ")} evidence is unavailable`;
    emit({ status: "blocked", detail });
    run.status = "failed";
    run.error = appendError({ existing: run.error, detail });
    run.currentOperation = "Model loading investigation was blocked by missing prerequisite evidence";
    run.completedAt = now();
    return run;
  }

  const autoClass = selectGenerationAutoClass({ repository, declarations });
  if (autoClass === undefined) {
    const detail = "Blocked because no supported public generative Auto class was observed";
    emit({ status: "blocked", detail });
    run.status = "failed";
    run.error = appendError({ existing: run.error, detail });
    run.currentOperation = "Model loading investigation was blocked by missing generative class support";
    run.completedAt = now();
    return run;
  }

  const candidates = modelFilePlan.candidates.filter(candidate => candidate.eligibility === "eligible");
  if (candidates.length === 0) {
    const detail = "Blocked because no fixed q4f16 or q4 candidate has all required repository files";
    emit({ status: "blocked", detail });
    run.status = "failed";
    run.error = appendError({ existing: run.error, detail });
    run.currentOperation = "Model loading investigation was blocked by candidate file availability";
    run.completedAt = now();
    return run;
  }

  let successfulAttempt: ModelSupportInvestigationLoadAttempt | undefined;
  emit({ status: "running", detail: `Starting ${candidates[0]?.candidateId} in a fresh investigation Worker` });
  for (const candidate of candidates) {
    let attempt: ModelSupportInvestigationLoadAttempt;
    try {
      attempt = await runAttempt({ candidate, autoClass });
    } catch (error) {
      attempt = unexpectedAttempt({
        candidate,
        autoClass,
        repositoryRevision: repository.resolvedRevision,
        error,
        now,
        createAttemptId,
      });
    }
    run.loadAttempts.push(attempt);
    switch (attempt.status) {
    case "passed":
      successfulAttempt = attempt;
      break;
    case "failed":
    case "blocked":
      break;
    default: {
      const _ex: never = attempt.status;
      return _ex;
    }
    }
    if (successfulAttempt !== undefined) break;
    if (attempt.loadedModel !== undefined && attempt.failureStage === "input-build") {
      break;
    }
    const nextCandidate = candidates[run.loadAttempts.length];
    if (nextCandidate !== undefined) {
      emit({ status: "running", detail: `Starting ${nextCandidate.candidateId} in a fresh investigation Worker` });
    }
  }

  if (successfulAttempt === undefined) {
    const loadedWithoutInput = run.loadAttempts.find(attempt => (
      attempt.loadedModel !== undefined && attempt.failureStage === "input-build"
    ));
    const detail = loadedWithoutInput === undefined
      ? `${run.loadAttempts.length} eligible candidates failed before minimum generation completed`
      : `${loadedWithoutInput.candidateId} loaded successfully, but deterministic generation input was unavailable`;
    emit({ status: "failed", detail });
    run.status = "failed";
    run.error = appendError({ existing: run.error, detail });
    run.currentOperation = "Model load attempts completed without a successful minimum generation";
  } else {
    emit({
      status: "passed",
      detail: `${successfulAttempt.candidateId} loaded and generated ${successfulAttempt.generatedTokenIds.length} token`,
    });
    run.currentOperation = "Minimum real-model generation evidence collected";
  }
  run.completedAt = now();
  return run;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  unexpectedAttempt,
};
