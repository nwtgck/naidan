import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationModelFilePlan,
  ModelSupportInvestigationPersistenceRoundTrip,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationStepId,
  ModelSupportInvestigationTemplateBehavior,
  ModelSupportInvestigationRuntimeTarget,
} from '@/features/transformers-js/model-support-investigation/types';
import { serializeInvestigationError } from '@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error';
import type { ModelSupportInvestigationExecutionPlan, ModelSupportInvestigationExternalNetworkPolicy } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import { runtimeTargetFromLocalCache, runtimeTargetFromRepository, selectLocalCacheRevision } from '@/features/transformers-js/model-support-investigation/logic/runtime-target';
import type { InvestigationReplayMetadataSummary } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';


function recordStepError({
  run,
  stepId,
  error,
}: {
  run: ModelSupportInvestigationRun,
  stepId: ModelSupportInvestigationStepId,
  error: unknown,
}) {
  const serialized = serializeInvestigationError({ error });
  run.stepErrors ??= {};
  run.stepErrors[stepId] = [...(run.stepErrors[stepId] ?? []), serialized];
  return serialized;
}

function updateStep({
  steps,
  stepId,
  status,
  detail,
}: {
  steps: ModelSupportInvestigationStep[],
  stepId: ModelSupportInvestigationStepId,
  status: ModelSupportInvestigationStep['status'],
  detail: string,
}): ModelSupportInvestigationStep[] {
  return steps.map((step) => {
    if (step.id === stepId) return { ...step, status, detail };
    return step;
  });
}

function declarationInspectionDetail({ runtimeTarget }: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
}): string {
  switch (runtimeTarget.source) {
  case 'repository':
    return 'Fetching lightweight declarations from the resolved commit and checking public Auto classes';
  case 'local-cache':
    return `Reading completed local declarations from cache revision ${runtimeTarget.evidenceRevision} and checking public Auto classes`;
  default: {
    const _ex: never = runtimeTarget.source;
    return _ex;
  }
  }
}

function modelFilePlanDetail({ runtimeTarget, eligible, candidateCount, failed }: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
  eligible: number,
  candidateCount: number,
  failed: number,
}): string {
  switch (runtimeTarget.source) {
  case 'repository':
    return `${eligible} of ${candidateCount} fixed candidates have all required repository files; ${failed} Registry failures`;
  case 'local-cache':
    return `${eligible} of ${candidateCount} fixed candidates have all required completed local cache files at revision ${runtimeTarget.evidenceRevision}; ${failed} Registry failures`;
  default: {
    const _ex: never = runtimeTarget.source;
    return _ex;
  }
  }
}

export async function runPartialModelSupportInvestigation({
  runRuntimePreflight,
  externalNetworkPolicy,
  executionPlan,
  inspectPersistenceRoundTrip,
  inspectRepository,
  collectReplayMetadata,
  collectDownloadEvidence,
  inspectCache,
  verifyCacheProvenance,
  inspectDeclarations,
  inspectTemplateBehavior,
  inspectModelFilePlan,
  deferTemplateBehavior = false,
  onEvent,
  onRunUpdate = () => undefined,
  now,
}: {
  runRuntimePreflight: () => Promise<ModelSupportInvestigationRun>,
  externalNetworkPolicy: ModelSupportInvestigationExternalNetworkPolicy,
  executionPlan: ModelSupportInvestigationExecutionPlan,
  inspectPersistenceRoundTrip: () => Promise<ModelSupportInvestigationPersistenceRoundTrip>,
  inspectRepository: () => Promise<ModelSupportInvestigationRepository>,
  collectReplayMetadata?: ({ run, onSummary }: {
    run: ModelSupportInvestigationRun,
    onSummary: ({ summary }: { summary: InvestigationReplayMetadataSummary }) => void,
  }) => Promise<void>,
  collectDownloadEvidence: ({ repository, runId }: {
    repository: ModelSupportInvestigationRepository,
    runId: string,
  }) => Promise<NonNullable<ModelSupportInvestigationRun['downloadEvidence']>>,
  inspectCache: () => Promise<ModelSupportInvestigationCacheInventory>,
  verifyCacheProvenance: ({ repository, cache }: {
    repository: ModelSupportInvestigationRepository,
    cache: ModelSupportInvestigationCacheInventory,
  }) => Promise<ModelSupportInvestigationCacheProvenance>,
  inspectDeclarations: ({ runtimeTarget, repository, cache }: {
    runtimeTarget: ModelSupportInvestigationRuntimeTarget,
    repository: ModelSupportInvestigationRepository | undefined,
    cache: ModelSupportInvestigationCacheInventory | undefined,
  }) => Promise<ModelSupportInvestigationModelDeclarations>,
  inspectTemplateBehavior: ({ runtimeTarget, repository }: {
    runtimeTarget: ModelSupportInvestigationRuntimeTarget,
    repository: ModelSupportInvestigationRepository | undefined,
  }) => Promise<ModelSupportInvestigationTemplateBehavior>,
  inspectModelFilePlan: ({ runtimeTarget, repository, declarations, cache }: {
    runtimeTarget: ModelSupportInvestigationRuntimeTarget,
    repository: ModelSupportInvestigationRepository | undefined,
    declarations: ModelSupportInvestigationModelDeclarations,
    cache: ModelSupportInvestigationCacheInventory | undefined,
  }) => Promise<ModelSupportInvestigationModelFilePlan>,
  deferTemplateBehavior?: boolean,
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  onRunUpdate?: ({ run }: { run: ModelSupportInvestigationRun }) => void,
  now: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const runtimeRun = await runRuntimePreflight();
  const run: ModelSupportInvestigationRun = {
    ...runtimeRun,
    scope: 'partial-runtime-repository-cache-declarations-template-model-files',
    repository: undefined,
    runtimeTarget: undefined,
    downloadEvidence: undefined,
    cache: undefined,
    declarations: undefined,
    templateBehavior: undefined,
    modelFilePlan: undefined,
    loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
    stepErrors: structuredClone(runtimeRun.stepErrors ?? {}),
  };
  if (executionPlan.continuity) {
    try {
      run.persistenceRoundTrip = await inspectPersistenceRoundTrip();
    } catch (error) {
      run.persistenceRoundTrip = {
        status: 'failed',
        fixtureId: 'tool-call-history-v1',
        method: 'chat-content-dto-json-roundtrip-v1',
        error: serializeInvestigationError({ error }),
      };
    }
  } else {
    run.persistenceRoundTrip = undefined;
  }
  onRunUpdate({ run: structuredClone(run) });

  const errors: string[] = (() => {
    switch (runtimeRun.status) {
    case 'failed':
      return [runtimeRun.error ?? runtimeRun.currentOperation];
    case 'passed':
      return [];
    default: {
      const exhaustiveStatus: never = runtimeRun.status;
      return exhaustiveStatus;
    }
    }
  })();
  const emit = ({ stepId, status, detail }: {
    stepId: ModelSupportInvestigationStepId,
    status: ModelSupportInvestigationStep['status'],
    detail: string,
  }): void => {
    run.steps = updateStep({ steps: run.steps, stepId, status, detail });
    run.currentOperation = detail;
    run.completedAt = now();
    onRunUpdate({ run: structuredClone(run) });
    onEvent({ event: { stepId, status, detail } });
  };

  if (!executionPlan.repositoryDownload) {
    emit({
      stepId: 'repository-information',
      status: 'skipped',
      detail: 'Skipped because Repository / Download is not selected by investigation scope',
    });
    emit({
      stepId: 'download-evidence',
      status: 'skipped',
      detail: 'Skipped because Repository / Download is not selected by investigation scope',
    });
  } else switch (externalNetworkPolicy) {
  case 'deny':
    emit({
      stepId: 'repository-information',
      status: 'skipped',
      detail: 'Skipped because external network access is disabled by investigation policy',
    });
    emit({
      stepId: 'download-evidence',
      status: 'skipped',
      detail: 'Skipped because external network access is disabled by investigation policy',
    });
    break;
  case 'allow':
    emit({ stepId: 'repository-information', status: 'running', detail: 'Resolving Hugging Face repository metadata and commit SHA' });
    try {
      run.repository = await inspectRepository();
      run.runtimeTarget = runtimeTargetFromRepository({ repository: run.repository });
      emit({
        stepId: 'repository-information',
        status: 'passed',
        detail: `Resolved ${run.repository.resolvedRevision} with ${run.repository.fileCount} repository files`,
      });
      if (!executionPlan.modelLoad && collectReplayMetadata !== undefined) {
        await collectReplayMetadata({ run, onSummary: ({ summary }) => {
          run.replayMetadata = summary;
          onRunUpdate({ run: structuredClone(run) });
        } });
      }
    } catch (error) {
      const detail = recordStepError({ run, stepId: 'repository-information', error }).message;
      errors.push(detail);
      emit({ stepId: 'repository-information', status: 'failed', detail });
    }

    if (run.repository === undefined) {
      emit({
        stepId: 'download-evidence',
        status: 'blocked',
        detail: 'Blocked because the resolved repository revision is unavailable',
      });
    } else {
      emit({
        stepId: 'download-evidence',
        status: 'running',
        detail: 'Collecting bounded transport and actual Transformers.js artifact-request evidence against the frozen revision',
      });
      try {
        run.downloadEvidence = await collectDownloadEvidence({ repository: run.repository, runId: run.runId });
        const observed = run.downloadEvidence.modelArtifactObservations.filter(item => item.status === 'observed').length;
        emit({
          stepId: 'download-evidence',
          status: 'running',
          detail: `${observed} actual candidate artifact-request observations and ${run.downloadEvidence.run.transportObservations.length} bounded transport probes collected; Production cache acceptance is pending`,
        });
      } catch (error) {
        const detail = recordStepError({ run, stepId: 'download-evidence', error }).message;
        errors.push(detail);
        emit({ stepId: 'download-evidence', status: 'failed', detail });
      }
    }
    break;
  default: {
    const _ex: never = externalNetworkPolicy;
    return _ex;
  }
  }

  emit({ stepId: 'existing-model-data', status: 'running', detail: 'Inspecting existing OPFS model files and completion markers' });
  try {
    run.cache = await inspectCache();
    onRunUpdate({ run: structuredClone(run) });
    let detail = run.cache.exists
      ? `Found ${run.cache.fileCount} files (${run.cache.totalBytes} bytes), ${run.cache.incompleteFileCount} incomplete`
      : 'No existing OPFS model directory was found';
    let status: ModelSupportInvestigationStep['status'] = 'passed';
    if (run.repository !== undefined && run.cache.exists) {
      try {
        run.cache.provenance = await verifyCacheProvenance({ repository: run.repository, cache: run.cache });
        detail = `${detail}; bounded cache provenance: ${run.cache.provenance.status}`;
      } catch (error) {
        const provenanceError = recordStepError({ run, stepId: 'existing-model-data', error }).message;
        errors.push(provenanceError);
        detail = `${detail}; bounded cache provenance failed: ${provenanceError}`;
        status = 'failed';
      }
    }
    emit({ stepId: 'existing-model-data', status, detail });
  } catch (error) {
    const detail = recordStepError({ run, stepId: 'existing-model-data', error }).message;
    errors.push(detail);
    emit({ stepId: 'existing-model-data', status: 'failed', detail });
  }

  let localRuntimeTargetFailure: string | undefined;
  if (run.runtimeTarget === undefined && run.cache !== undefined) {
    const selection = selectLocalCacheRevision({ cache: run.cache });
    run.runtimeTarget = runtimeTargetFromLocalCache({ cache: run.cache });
    if (run.runtimeTarget === undefined) {
      switch (selection.status) {
      case 'unavailable':
      case 'ambiguous':
        localRuntimeTargetFailure = selection.reason;
        break;
      case 'selected':
        localRuntimeTargetFailure = 'Local cache revision was selected but no RuntimeTarget could be constructed';
        break;
      default: {
        const _ex: never = selection;
        throw new Error(`Unhandled local cache revision selection: ${String(_ex)}`);
      }
      }
    }
  }
  onRunUpdate({ run: structuredClone(run) });

  // Replay collection also records an unverified/missing offline identity without remote fallback.
  if (executionPlan.repositoryDownload && !executionPlan.modelLoad && run.replayMetadata === undefined && collectReplayMetadata !== undefined) {
    await collectReplayMetadata({ run, onSummary: ({ summary }) => {
      run.replayMetadata = summary;
      onRunUpdate({ run: structuredClone(run) });
    } });
  }

  if (run.runtimeTarget === undefined) {
    const blockedDetail = (() => {
      switch (externalNetworkPolicy) {
      case 'deny':
        return localRuntimeTargetFailure === undefined
          ? 'Blocked because remote repository evidence was skipped and no usable local RuntimeTarget was found'
          : `Blocked because remote repository evidence was skipped and local RuntimeTarget is unavailable: ${localRuntimeTargetFailure}`;
      case 'allow':
        return localRuntimeTargetFailure === undefined
          ? 'Blocked because neither remote repository evidence nor a usable local RuntimeTarget is available'
          : `Blocked because remote repository resolution failed and local RuntimeTarget is unavailable: ${localRuntimeTargetFailure}`;
      default: {
        const _ex: never = externalNetworkPolicy;
        throw new Error(`Unhandled external network policy: ${_ex}`);
      }
      }
    })();
    emit({
      stepId: 'model-declarations',
      status: 'blocked',
      detail: blockedDetail,
    });
    emit({
      stepId: 'template-behavior',
      status: 'blocked',
      detail: blockedDetail,
    });
    emit({
      stepId: 'model-file-plan',
      status: 'blocked',
      detail: blockedDetail,
    });
  } else {
    emit({
      stepId: 'model-declarations',
      status: 'running',
      detail: declarationInspectionDetail({ runtimeTarget: run.runtimeTarget }),
    });
    try {
      run.declarations = await inspectDeclarations({ runtimeTarget: run.runtimeTarget, repository: run.repository, cache: run.cache });
      const supported = run.declarations.classCapabilities
        .filter(entry => entry.supports === true)
        .map(entry => entry.autoClass);
      const modelType = run.declarations.modelType ?? 'missing model_type';
      emit({
        stepId: 'model-declarations',
        status: 'passed',
        detail: run.declarations.fileFailures.length === 0
          ? `${modelType}: ${supported.length} public Auto classes support this model type`
          : `${modelType}: ${supported.length} public Auto classes support this model type; ${run.declarations.fileFailures.length} optional declaration files failed and were preserved as evidence`,
      });
    } catch (error) {
      const detail = recordStepError({ run, stepId: 'model-declarations', error }).message;
      errors.push(detail);
      emit({ stepId: 'model-declarations', status: 'failed', detail });
    }

    if (run.declarations === undefined) {
      emit({
        stepId: 'model-file-plan',
        status: 'blocked',
        detail: 'Blocked because model declarations are unavailable',
      });
    } else {
      emit({
        stepId: 'model-file-plan',
        status: 'running',
        detail: 'Planning fixed q4f16 and q4 model files with Transformers.js ModelRegistry',
      });
      try {
        run.modelFilePlan = await inspectModelFilePlan({
          runtimeTarget: run.runtimeTarget,
          repository: run.repository,
          declarations: run.declarations,
          cache: run.cache,
        });
        const eligible = run.modelFilePlan.candidates.filter(candidate => candidate.eligibility === 'eligible').length;
        const failed = run.modelFilePlan.candidates.filter(candidate => candidate.registryStatus === 'failed').length;
        emit({
          stepId: 'model-file-plan',
          status: 'passed',
          detail: modelFilePlanDetail({
            runtimeTarget: run.runtimeTarget,
            eligible,
            candidateCount: run.modelFilePlan.candidates.length,
            failed,
          }),
        });
      } catch (error) {
        const detail = recordStepError({ run, stepId: 'model-file-plan', error }).message;
        errors.push(detail);
        emit({ stepId: 'model-file-plan', status: 'failed', detail });
      }
    }

    if (!executionPlan.generation) {
      emit({
        stepId: 'template-behavior',
        status: 'skipped',
        detail: 'Skipped because Generation is not selected by investigation scope',
      });
    } else if (deferTemplateBehavior && run.runtimeTarget.source === 'repository') {
      emit({
        stepId: 'template-behavior',
        status: 'blocked',
        detail: 'Deferred until runtime-complete preparation has selected a Production-accepted cache revision',
      });
    } else {
      emit({
        stepId: 'template-behavior',
        status: 'running',
        detail: 'Loading the tokenizer through the normal Chat revision while preserving the resolved commit as evidence',
      });
      try {
        run.templateBehavior = await inspectTemplateBehavior({ runtimeTarget: run.runtimeTarget, repository: run.repository });
        const passed = run.templateBehavior.cases.filter(item => item.status === 'passed').length;
        const failed = run.templateBehavior.cases.length - passed;
        emit({
          stepId: 'template-behavior',
          status: 'passed',
          detail: `${run.templateBehavior.tokenizerClass}: ${passed} template cases rendered, ${failed} recorded as unsupported or failed`,
        });
      } catch (error) {
        const detail = recordStepError({ run, stepId: 'template-behavior', error }).message;
        errors.push(detail);
        emit({ stepId: 'template-behavior', status: 'failed', detail });
      }
    }
  }

  run.completedAt = now();
  run.status = errors.length === 0 ? 'passed' : 'failed';
  run.error = errors.length === 0 ? undefined : errors.join('; ');
  run.currentOperation = errors.length === 0
    ? 'Selected investigation planning evidence collected'
    : 'Partial evidence collected with investigation failures';
  return run;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
