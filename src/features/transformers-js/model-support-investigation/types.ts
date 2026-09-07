import type {
  TransformersJsProductionInvestigationError,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
} from '@/features/transformers-js/types';
import type { WorkerProxy } from '@/utils/worker-transport';

export type ModelSupportInvestigationJsonValue =
  | string
  | number
  | boolean
  | null
  | ModelSupportInvestigationJsonValue[]
  | ModelSupportInvestigationJsonObject;

export interface ModelSupportInvestigationJsonObject {
  [key: string]: ModelSupportInvestigationJsonValue,
}

export type ModelSupportInvestigationStepId =
  | "runtime-assets"
  | "repository-information"
  | "existing-model-data"
  | "model-declarations"
  | "template-behavior"
  | "model-file-plan"
  | "loading-investigation"
  | "lane-comparison"
  | "evidence-export";

export type ModelSupportInvestigationStepStatus =
  | "not-run"
  | "running"
  | "passed"
  | "failed"
  | "blocked";

export interface ModelSupportInvestigationStep {
  id: ModelSupportInvestigationStepId,
  status: ModelSupportInvestigationStepStatus,
  detail: string | undefined,
}

export type ModelSupportInvestigationRuntimeControl =
  | {
      fixtureId: 'identity-float32-v1',
      fixtureSha256: string,
      executionProvider: 'wasm',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: number,
      error: undefined,
    }
  | {
      fixtureId: 'identity-float32-v1',
      fixtureSha256: string,
      executionProvider: 'wasm',
      status: 'failed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: number | undefined,
      error: string,
    };

export interface ModelSupportInvestigationWebGpuRuntimeControl {
  fixtureId: 'identity-float32-v1',
  fixtureSha256: string,
  executionProvider: 'webgpu',
  status: 'passed' | 'failed' | 'not-available',
  inputName: 'x',
  outputName: 'y',
  inputValue: 7,
  outputValue: number | undefined,
  error: string | undefined,
}

export interface ModelSupportInvestigationRuntimeEnvironment {
  userAgent: string,
  vendor: string,
  hardwareConcurrency: number,
  deviceMemoryGiB: number | undefined,
  crossOriginIsolated: boolean,
  webGpu: {
    availability: 'available' | 'unavailable' | 'request-failed',
    adapterInfo: Record<string, string>,
    features: string[],
    limits: Record<string, number>,
    error: string | undefined,
  },
}

export interface ModelSupportInvestigationRuntimeAssetIdentity {
  manifestBuildId: string,
  manifestUrl: string | undefined,
  observedManifestBuildId: string | undefined,
  versions: {
    transformers: string,
    onnxRuntimeWeb: string,
    onnxRuntimeCommon: string,
    onnxRuntimeWebBundledCommon: string,
  },
  mjs: {
    url: string,
    expectedByteLength: number,
    observedByteLength: number | undefined,
    expectedSha256: string,
    observedSha256: string | undefined,
  },
  wasm: {
    logicalUrl: string,
    physicalUrl: string,
    expectedByteLength: number,
    observedByteLength: number | undefined,
    expectedSha256: string,
    observedSha256: string | undefined,
    expectedPhysicalByteLength: number,
    observedPhysicalByteLength: number | undefined,
    expectedPhysicalSha256: string,
    observedPhysicalSha256: string | undefined,
  },
}

export interface ModelSupportInvestigationWasmThreadingObservation {
  requestedThreads: number | undefined,
  effectiveThreads: number | undefined,
  effectiveThreadsBasis: "runtime-env-after-control" | "unavailable",
  proxy: boolean | undefined,
  childWorkerLifecycle: "not-observed",
  childWorkerLifecycleReason: string,
}

export interface ModelSupportInvestigationRuntimeAssets {
  variant: "standard" | "asyncify",
  assetIdentity?: ModelSupportInvestigationRuntimeAssetIdentity,
  baseUrl: string,
  mjsUrl: string,
  wasmUrl: string,
  wasmByteLength: number,
  mjsOrigin: string,
  wasmOrigin: string,
  applicationOrigin: string,
  environment: ModelSupportInvestigationRuntimeEnvironment,
  threading?: ModelSupportInvestigationWasmThreadingObservation,
  control: ModelSupportInvestigationRuntimeControl,
  webGpuControl: ModelSupportInvestigationWebGpuRuntimeControl,
}

export type ModelSupportInvestigationRuntimePreflightStage =
  | "origin-validation"
  | "environment"
  | "module-import"
  | "wasm-fetch"
  | "wasm-validation"
  | "wasm-control"
  | "webgpu-control";

export type ModelSupportInvestigationRuntimePreflightStageObservation =
  | {
      stage: ModelSupportInvestigationRuntimePreflightStage,
      status: "passed",
      detail: string,
    }
  | {
      stage: ModelSupportInvestigationRuntimePreflightStage,
      status: "failed",
      detail: string,
      error: string,
    }
  | {
      stage: ModelSupportInvestigationRuntimePreflightStage,
      status: "not-run",
      detail: string,
      reason: string,
    };

export interface ModelSupportInvestigationRuntimeAssetsPartial {
  variant: "standard" | "asyncify",
  assetIdentity?: ModelSupportInvestigationRuntimeAssetIdentity,
  baseUrl: string,
  mjsUrl: string,
  wasmUrl: string,
  physicalWasmUrl: string,
  applicationOrigin: string,
  mjsOrigin: string | undefined,
  wasmOrigin: string | undefined,
  physicalWasmOrigin: string | undefined,
  environment: ModelSupportInvestigationRuntimeEnvironment | undefined,
  threading?: ModelSupportInvestigationWasmThreadingObservation,
  wasmByteLength: number | undefined,
  control: ModelSupportInvestigationRuntimeControl | undefined,
  webGpuControl: ModelSupportInvestigationWebGpuRuntimeControl | undefined,
  currentStage: ModelSupportInvestigationRuntimePreflightStage | undefined,
  stageObservations: ModelSupportInvestigationRuntimePreflightStageObservation[],
}

export interface ModelSupportInvestigationRepositoryFile {
  path: string,
  size: number | undefined,
  blobId: string | undefined,
  lfsOid: string | undefined,
}

export interface ModelSupportInvestigationRepository {
  requestedModelId: string,
  normalizedModelId: string,
  requestedRevision: 'main',
  resolvedRevision: string,
  apiUrl: string,
  responseUrl: string,
  fileCount: number,
  files: ModelSupportInvestigationRepositoryFile[],
  pipelineTag: string | undefined,
  libraryName: string | undefined,
  metadata: ModelSupportInvestigationJsonObject,
}


export type ModelSupportInvestigationAutoClassName =
  | 'AutoModel'
  | 'AutoModelForCausalLM'
  | 'AutoModelForSeq2SeqLM'
  | 'AutoModelForVision2Seq'
  | 'AutoModelForImageTextToText'
  | 'AutoModelForAudioTextToText'
  | 'AutoModelForSpeechSeq2Seq';

export interface ModelSupportInvestigationDeclarationFile {
  path: string,
  url: string,
  responseUrl: string,
  byteLength: number,
  contentType: string | undefined,
  value: ModelSupportInvestigationJsonValue,
}

export interface ModelSupportInvestigationDeclarationFileFailure {
  path: string,
  url: string,
  error: ModelSupportInvestigationLoadAttemptError,
}

export interface ModelSupportInvestigationClassCapability {
  autoClass: ModelSupportInvestigationAutoClassName,
  supports: boolean | undefined,
  notEvaluatedReason: string | undefined,
}

export interface ModelSupportInvestigationModelDeclarations {
  normalizedModelId: string,
  resolvedRevision: string,
  files: ModelSupportInvestigationDeclarationFile[],
  fileFailures: ModelSupportInvestigationDeclarationFileFailure[],
  config: ModelSupportInvestigationJsonObject,
  modelType: string | undefined,
  architectures: string[],
  autoMap: ModelSupportInvestigationJsonObject | undefined,
  transformersJsConfig: ModelSupportInvestigationJsonObject | undefined,
  classCapabilities: ModelSupportInvestigationClassCapability[],
}

export type ModelSupportInvestigationTemplateCaseId =
  | 'user-generation'
  | 'system-user-generation'
  | 'multi-turn-generation'
  | 'tools-generation'
  | 'assistant-tool-call-history'
  | 'tool-result-continuation';

export interface ModelSupportInvestigationTemplateMessage {
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
  tool_calls?: Array<{
    id: string,
    type: 'function',
    function: {
      name: string,
      arguments: string,
    },
  }>,
  tool_call_id?: string,
}

export interface ModelSupportInvestigationTemplateCase {
  caseId: ModelSupportInvestigationTemplateCaseId,
  messages: ModelSupportInvestigationTemplateMessage[],
  tools: ModelSupportInvestigationJsonObject[] | undefined,
  addGenerationPrompt: boolean,
  status: 'passed' | 'failed',
  selectedTemplate: string | undefined,
  renderedText: string | undefined,
  inputIds: number[] | undefined,
  failureStage: 'template-selection' | 'render' | 'tokenize' | undefined,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export type ModelSupportInvestigationToolTemplateProvenance =
  | {
    status: 'observed',
    source: 'chat-template-render',
    generationCaseId: 'tools-generation',
    assistantToolCallCaseId: 'assistant-tool-call-history',
    toolResultContinuationCaseId: 'tool-result-continuation',
    generationInputIds: number[],
    assistantToolCallInputIds: number[],
    toolResultContinuationInputIds: number[] | undefined,
    generationPromptPrefixMatch: boolean,
    firstMismatchIndex: number | undefined,
    assistantToolCallSuffixTokenIds: number[] | undefined,
  }
  | {
    status: 'unavailable',
    source: 'chat-template-render',
    generationCaseId: 'tools-generation',
    assistantToolCallCaseId: 'assistant-tool-call-history',
    toolResultContinuationCaseId: 'tool-result-continuation',
    reason: string,
  };

export interface ModelSupportInvestigationTemplateBehavior {
  normalizedModelId: string,
  resolvedRevision: string,
  tokenizerClass: string,
  declaredChatTemplate: ModelSupportInvestigationJsonValue | undefined,
  cases: ModelSupportInvestigationTemplateCase[],
  toolTemplateProvenance?: ModelSupportInvestigationToolTemplateProvenance,
}

export type ModelSupportInvestigationCandidateId =
  | "webgpu-q4f16"
  | "webgpu-q4"
  | "wasm-q4";

export type ModelSupportInvestigationCandidateDevice = "webgpu" | "wasm";
export type ModelSupportInvestigationCandidateDtype = "q4f16" | "q4";

export type ModelSupportInvestigationPlannedFileKind =
  | "config"
  | "core-onnx"
  | "external-data"
  | "optional-config";

export interface ModelSupportInvestigationPlannedFileCacheMatch {
  path: string,
  size: number,
  hasCompletionMarker: boolean,
  observation:
    | "complete-marker-observed-revision-unknown"
    | "incomplete-observed-revision-unknown"
    | "zero-byte-observed-revision-unknown",
}

export interface ModelSupportInvestigationPlannedFile {
  path: string,
  kind: ModelSupportInvestigationPlannedFileKind,
  requirement: "required" | "optional",
  repositoryObservation: "present" | "missing" | "zero-byte",
  repositorySize: number | undefined,
  repositoryBlobId: string | undefined,
  repositoryLfsOid: string | undefined,
  cacheMatches: ModelSupportInvestigationPlannedFileCacheMatch[],
}

export interface ModelSupportInvestigationCandidateFilePlan {
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
  registryStatus: "planned" | "failed",
  registryError: ModelSupportInvestigationLoadAttemptError | undefined,
  registryReturnedFileCount: number,
  duplicatePaths: string[],
  files: ModelSupportInvestigationPlannedFile[],
  requiredFileCount: number,
  optionalFileCount: number,
  missingRequiredFileCount: number,
  zeroByteRequiredFileCount: number,
  missingOptionalFileCount: number,
  cacheObservedRequiredFileCount: number,
  cacheCompleteMarkerRequiredFileCount: number,
  eligibility: "eligible" | "ineligible" | "registry-failed",
  ineligibleReasons: string[],
}

export type ModelSupportInvestigationGenerationAutoClassName =
  | "AutoModelForCausalLM"
  | "AutoModelForSeq2SeqLM"
  | "AutoModelForVision2Seq"
  | "AutoModelForImageTextToText"
  | "AutoModelForAudioTextToText"
  | "AutoModelForSpeechSeq2Seq";

export type ModelSupportInvestigationLoadAttemptStage =
  | "worker-start"
  | "auto-class-selection"
  | "model-load"
  | "input-build"
  | "first-generation"
  | "natural-generation"
  | "tool-protocol-probe"
  | "dispose";

export interface ModelSupportInvestigationLoadAttemptEvent {
  stage: ModelSupportInvestigationLoadAttemptStage,
  status: "running" | "passed" | "failed" | "skipped",
  detail: string,
  at: string,
}

export interface ModelSupportInvestigationSessionMetadata {
  name: string,
  inputNames: string[],
  outputNames: string[],
}

export interface ModelSupportInvestigationSessionFileCorrelation {
  sessionName: string,
  status: "exact" | "ambiguous" | "unmatched",
  matchBasis: "exact-session-name-to-core-onnx-basename",
  coreFilePaths: string[],
  externalDataPaths: string[],
}

export interface ModelSupportInvestigationInputTensorMetadata {
  name: string,
  dtype: string,
  dims: number[],
  location: string | undefined,
}

export type ModelSupportInvestigationTextInputStrategy =
  | "chat-template-tensor-dict"
  | "observed-token-ids-transformers-tensor"
  | "fixed-plain-text-tokenizer-tensor-dict";

export interface ModelSupportInvestigationInputStrategyAttempt {
  strategy: ModelSupportInvestigationTextInputStrategy,
  status: "passed" | "failed",
  failureStage: "input-build" | "first-generation" | undefined,
  inputTokenIds: number[],
  inputTensors: ModelSupportInvestigationInputTensorMetadata[],
  inputText?: string,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export interface ModelSupportInvestigationLoadedModelObservation {
  modelType: string | undefined,
  isEncoderDecoder: boolean | undefined,
  sessions: ModelSupportInvestigationSessionMetadata[],
  sessionFileCorrelations: ModelSupportInvestigationSessionFileCorrelation[],
  effectiveMinimumGenerationConfig: {
    maxNewTokens: 1,
    doSample: false,
    bosTokenId: ModelSupportInvestigationJsonValue | undefined,
    eosTokenId: ModelSupportInvestigationJsonValue | undefined,
    padTokenId: ModelSupportInvestigationJsonValue | undefined,
    decoderStartTokenId: ModelSupportInvestigationJsonValue | undefined,
  },
}

export type ModelSupportInvestigationNaturalGenerationObservation =
  | {
      status: "observed",
      forced: false,
      maxNewTokens: 16,
      doSample: false,
      generatedTokenIds: number[],
      generatedText: string,
      termination: "limit-reached" | "ended-before-limit",
    }
  | {
      status: "failed",
      forced: false,
      maxNewTokens: 16,
      doSample: false,
      error: ModelSupportInvestigationLoadAttemptError,
    };

export interface ModelSupportInvestigationNormalizedToolCall {
  name: string,
  arguments: string,
}

export type ModelSupportInvestigationToolParserObservation =
  | {
    status: "observed",
    strategy: "standard" | "gpt-oss" | "qwen3_5",
    parserKind:
      | "standard-tool-call-stream-parser"
      | "gpt-oss-harmony-output-interpreter"
      | "qwen3_5-tool-call-parser",
    inputMode: "production-text-streamer-reconstruction",
    inputChunks: string[],
    visibleText: string,
    callBoundaryCount: number | undefined,
    toolCalls: ModelSupportInvestigationNormalizedToolCall[],
    recognized: boolean,
  }
  | {
    status: "unavailable",
    strategy: "gemma4",
    reason: string,
  }
  | {
    status: "failed",
    strategy: "standard" | "gpt-oss" | "qwen3_5" | "gemma4",
    inputChunks: string[],
    error: ModelSupportInvestigationLoadAttemptError,
  };

export type ModelSupportInvestigationToolResultTemplateRoundTrip =
  | {
    status: "observed",
    source: "recognized-production-parser-and-chat-template",
    parserStrategy: "standard" | "gpt-oss" | "qwen3_5",
    toolCall: ModelSupportInvestigationNormalizedToolCall,
    toolResultContent: string,
    selectedTemplate: string,
    renderedText: string,
    inputTokenIds: number[],
  }
  | {
    status: "unavailable",
    reason: string,
  }
  | {
    status: "failed",
    error: ModelSupportInvestigationLoadAttemptError,
  };

export type ModelSupportInvestigationToolProtocolProbe =
  | {
    status: "observed",
    forced: true,
    source: "chat-template-render",
    generationCaseId: "tools-generation",
    assistantToolCallCaseId: "assistant-tool-call-history",
    toolResultContinuationCaseId: "tool-result-continuation",
    inputTokenIds: number[],
    forcedTokenIds: number[],
    generatedTokenIds: number[],
    generatedText: string,
    exactMatch: boolean,
    firstMismatchIndex: number | undefined,
    termination: "complete-forced-sequence" | "ended-before-forced-sequence",
    parserObservation: ModelSupportInvestigationToolParserObservation,
    toolResultTemplateRoundTrip?: ModelSupportInvestigationToolResultTemplateRoundTrip,
  }
  | {
    status: "unavailable",
    forced: false,
    source: "chat-template-render",
    generationCaseId: "tools-generation",
    assistantToolCallCaseId: "assistant-tool-call-history",
    toolResultContinuationCaseId: "tool-result-continuation",
    reason: string,
  }
  | {
    status: "failed",
    forced: true,
    source: "chat-template-render",
    generationCaseId: "tools-generation",
    assistantToolCallCaseId: "assistant-tool-call-history",
    toolResultContinuationCaseId: "tool-result-continuation",
    inputTokenIds: number[],
    forcedTokenIds: number[],
    error: ModelSupportInvestigationLoadAttemptError,
  };

export type ModelSupportInvestigationLoadAttemptError = TransformersJsProductionInvestigationError;

export interface ModelSupportInvestigationPersistenceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
  tool_calls: Array<{
    id: string,
    type: 'function',
    function: {
      name: string,
      arguments: string,
    },
  }> | undefined,
  tool_call_id: string | undefined,
}

export type ModelSupportInvestigationPersistenceRoundTrip =
  | {
      status: 'observed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      modelVisibleProjectionMethod?: 'build-chat-generation-messages-v1',
      serializedByteLength: number,
      serializedSha256: string,
      originalMessages: ModelSupportInvestigationPersistenceMessage[],
      restoredMessages: ModelSupportInvestigationPersistenceMessage[],
      exactModelVisibleMatch: boolean,
      firstMismatchIndex: number | undefined,
    }
  | {
      status: 'failed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      error: ModelSupportInvestigationLoadAttemptError,
    };

export interface ModelSupportInvestigationCandidateRequiredFileCoverage {
  expectedPaths: string[],
  completePaths: string[],
  sizeMismatchPaths: string[],
  incompletePaths: string[],
  missingPaths: string[],
  revisionProvenance: 'unknown',
}

export type ModelSupportInvestigationPostAttemptCacheObservation =
  | {
      status: "observed",
      inventory: ModelSupportInvestigationCacheInventory,
      requiredFileCoverage: ModelSupportInvestigationCandidateRequiredFileCoverage,
    }
  | {
      status: "failed",
      error: ModelSupportInvestigationLoadAttemptError,
    };

export interface ModelSupportInvestigationLoadAttempt {
  attemptId: string,
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
  autoClass: ModelSupportInvestigationGenerationAutoClassName | undefined,
  resolvedRevision: string,
  startedAt: string,
  completedAt: string,
  status: "passed" | "failed" | "blocked",
  failureStage: ModelSupportInvestigationLoadAttemptStage | undefined,
  events: ModelSupportInvestigationLoadAttemptEvent[],
  inputStrategyAttempts: ModelSupportInvestigationInputStrategyAttempt[],
  interruptedInputStrategy?: ModelSupportInvestigationTextInputStrategy,
  selectedInputStrategy: ModelSupportInvestigationTextInputStrategy | undefined,
  inputTokenCount: number | undefined,
  inputTokenIds: number[],
  inputTensors: ModelSupportInvestigationInputTensorMetadata[],
  loadedModel: ModelSupportInvestigationLoadedModelObservation | undefined,
  generatedTokenIds: number[],
  generatedText: string | undefined,
  naturalGeneration: ModelSupportInvestigationNaturalGenerationObservation | undefined,
  toolProtocolProbe: ModelSupportInvestigationToolProtocolProbe | undefined,
  postAttemptCache?: ModelSupportInvestigationPostAttemptCacheObservation,
  modelType: string | undefined,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export interface ModelSupportInvestigationLoadAttemptCheckpoint {
  attemptId: string,
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
  autoClass: ModelSupportInvestigationGenerationAutoClassName | undefined,
  resolvedRevision: string,
  startedAt: string,
  checkpointedAt: string,
  status: "running",
  currentStage: ModelSupportInvestigationLoadAttemptStage,
  events: ModelSupportInvestigationLoadAttemptEvent[],
  inputStrategyAttempts: ModelSupportInvestigationInputStrategyAttempt[],
  activeInputStrategy: ModelSupportInvestigationTextInputStrategy | undefined,
  activeInputText?: string,
  selectedInputStrategy: ModelSupportInvestigationTextInputStrategy | undefined,
  inputTokenCount: number | undefined,
  inputTokenIds: number[],
  inputTensors: ModelSupportInvestigationInputTensorMetadata[],
  loadedModel: ModelSupportInvestigationLoadedModelObservation | undefined,
  generatedTokenIds: number[],
  generatedText: string | undefined,
  naturalGeneration: ModelSupportInvestigationNaturalGenerationObservation | undefined,
  toolProtocolProbe: ModelSupportInvestigationToolProtocolProbe | undefined,
  modelType: string | undefined,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}


export interface ModelSupportInvestigationProductionLane {
  status: 'passed' | 'failed' | 'running' | 'not-run',
  observation: TransformersJsProductionInvestigationObservation | undefined,
  partialObservation?: TransformersJsProductionInvestigationPartialObservation,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export interface ModelSupportInvestigationLaneComparison {
  scenarioCaseId: 'user-generation',
  referenceAttemptId: string,
  exactInputMatch: boolean,
  firstInputMismatchIndex: number | undefined,
  referenceInputTokenIds: number[],
  productionInputTokenIds: number[],
  referenceGeneratedTokenIds: number[],
  productionGeneratedTokenIds: number[],
  productionRoute: TransformersJsProductionInvestigationObservation['route'],
}

export interface ModelSupportInvestigationModelFilePlan {
  normalizedModelId: string,
  resolvedRevision: string,
  modelType: string | undefined,
  registrySource: "ModelRegistry.get_model_files",
  cacheRevisionProvenance: "unknown" | "not-observed",
  cacheRevisionProvenanceReason: string,
  candidates: ModelSupportInvestigationCandidateFilePlan[],
}

export interface ModelSupportInvestigationCacheFile {
  path: string,
  repositoryPath: string | undefined,
  cacheRevision?: string,
  size: number,
  lastModified: number,
  hasCompletionMarker: boolean,
  isWeightFile: boolean,
}

export interface ModelSupportInvestigationCacheRangeSample {
  offset: number,
  length: number,
  status: "matched" | "mismatched" | "range-not-supported" | "failed",
  localSha256: string | undefined,
  remoteSha256: string | undefined,
  responseStatus: number | undefined,
  contentRange: string | undefined,
  etag: string | undefined,
  lastModified: string | undefined,
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export interface ModelSupportInvestigationCacheTransportAttempt {
  method: "HEAD" | "range-0-0",
  status: "observed" | "unsupported" | "failed",
  requestUrl: string,
  responseUrl: string | undefined,
  responseStatus: number | undefined,
  redirected: boolean | undefined,
  redirectChain: string[] | undefined,
  redirectChainReason: string,
  contentLength: string | undefined,
  contentRange: string | undefined,
  contentType: string | undefined,
  acceptRanges: string | undefined,
  etag: string | undefined,
  lastModified: string | undefined,
  corsVisibility: "readable" | "unresolved",
  error: ModelSupportInvestigationLoadAttemptError | undefined,
}

export interface ModelSupportInvestigationCacheTransportObservation {
  status: "observed" | "fallback-metadata",
  attempts: ModelSupportInvestigationCacheTransportAttempt[],
  repositorySize: number | undefined,
  reason: string,
}

export interface ModelSupportInvestigationCacheFileProvenance {
  cachePath: string,
  repositoryPath: string,
  cacheRevision: string,
  localSize: number,
  repositorySize: number | undefined,
  status: "bounded-samples-matched" | "mismatched" | "partial",
  transport?: ModelSupportInvestigationCacheTransportObservation,
  ranges: ModelSupportInvestigationCacheRangeSample[],
  reason: string,
}

export interface ModelSupportInvestigationCacheProvenance {
  schemaVersion: 1,
  method: "bounded-range-sha256-v1",
  resolvedRevision: string,
  rangeBytes: number,
  maximumFileCount: number,
  status: "bounded-samples-matched" | "mismatched" | "partial" | "not-observed",
  confidence: "bounded-samples-matched" | "bounded-sample-mismatch" | "incomplete" | "none",
  files: ModelSupportInvestigationCacheFileProvenance[],
  reason: string,
}

export interface ModelSupportInvestigationCacheInventory {
  normalizedModelId: string,
  rootPath: string,
  exists: boolean,
  revisionProvenance: 'unknown',
  revisionProvenanceReason: string,
  totalBytes: number,
  fileCount: number,
  completionMarkerCount: number,
  incompleteFileCount: number,
  orphanCompletionMarkerCount: number,
  orphanCompletionMarkerPaths: string[],
  zeroByteFileCount: number,
  weightFileCount: number,
  allFilesHaveCompletionMarkers: boolean,
  files: ModelSupportInvestigationCacheFile[],
  provenance?: ModelSupportInvestigationCacheProvenance,
}

export interface ModelSupportInvestigationRun {
  schemaVersion: 1,
  runId: string,
  modelId: string,
  scope:
    | "partial-runtime-preflight"
    | "partial-runtime-repository-cache"
    | "partial-runtime-repository-cache-declarations"
    | "partial-runtime-repository-cache-declarations-template"
    | "partial-runtime-repository-cache-declarations-template-model-files"
    | "partial-runtime-repository-cache-declarations-template-model-files-load"
    | "partial-runtime-repository-cache-declarations-template-model-files-load-lanes",
  startedAt: string,
  completedAt: string,
  status: "passed" | "failed",
  currentOperation: string,
  steps: ModelSupportInvestigationStep[],
  runtimeAssets: ModelSupportInvestigationRuntimeAssets | undefined,
  runtimeAssetsPartial?: ModelSupportInvestigationRuntimeAssetsPartial,
  repository: ModelSupportInvestigationRepository | undefined,
  cache: ModelSupportInvestigationCacheInventory | undefined,
  declarations: ModelSupportInvestigationModelDeclarations | undefined,
  templateBehavior: ModelSupportInvestigationTemplateBehavior | undefined,
  persistenceRoundTrip?: ModelSupportInvestigationPersistenceRoundTrip,
  modelFilePlan: ModelSupportInvestigationModelFilePlan | undefined,
  loadAttempts: ModelSupportInvestigationLoadAttempt[],
  activeLoadAttempt?: ModelSupportInvestigationLoadAttemptCheckpoint,
  productionLane: ModelSupportInvestigationProductionLane,
  laneComparison: ModelSupportInvestigationLaneComparison | undefined,
  stepErrors?: Partial<Record<ModelSupportInvestigationStepId, ModelSupportInvestigationLoadAttemptError[]>>,
  error: string | undefined,
}

export type ModelSupportInvestigationPlanningWorkerRun = Omit<
  ModelSupportInvestigationRun,
  'loadAttempts' | 'activeLoadAttempt' | 'productionLane' | 'laneComparison'
>;

export type ModelSupportInvestigationEvidenceReadinessStatus =
  | "implementation-ready"
  | "partial"
  | "insufficient"
  | "not-observed";

export type ModelSupportInvestigationEvidenceDomainId =
  | "runtime-assets"
  | "repository"
  | "cache"
  | "model-declarations"
  | "template-tokenizer"
  | "model-file-plan"
  | "runtime-load"
  | "plain-text"
  | "production-routing"
  | "continuity-kv-cache"
  | "tools"
  | "reasoning"
  | "multimodal";

export interface ModelSupportInvestigationEvidenceQuestion {
  questionId: string,
  status: "answered" | "unobserved" | "contradictory",
  answer: string,
  evidencePaths: string[],
}

export interface ModelSupportInvestigationEvidenceDomainReadiness {
  domainId: ModelSupportInvestigationEvidenceDomainId,
  status: ModelSupportInvestigationEvidenceReadinessStatus,
  summary: string,
  questions: ModelSupportInvestigationEvidenceQuestion[],
}

export type ModelSupportInvestigationSupportBoundary =
  | "repository-artifact"
  | "transformers-js-capability"
  | "environment-runtime"
  | "naidan-production-adapter"
  | "cross-boundary"
  | "unresolved";

export interface ModelSupportInvestigationSupportBoundaryAssessment {
  assessmentId: string,
  boundary: ModelSupportInvestigationSupportBoundary,
  basis: "exact-observation" | "differential-observation" | "unresolved",
  summary: string,
  evidencePaths: string[],
  contradictoryEvidencePaths: string[],
}

export interface ModelSupportInvestigationEvidenceReadinessReport {
  schemaVersion: 1,
  overall: "partial" | "insufficient",
  domains: ModelSupportInvestigationEvidenceDomainReadiness[],
}

export type ModelSupportInvestigationEvidencePackageStatus =
  | "valid-partial"
  | "valid-insufficient"
  | "valid-interrupted"
  | "invalid";

export interface ModelSupportInvestigationEvidencePackageAssessment {
  schemaVersion: 1,
  status: ModelSupportInvestigationEvidencePackageStatus,
  runId: string,
  runStatus: "passed" | "failed",
  recoveryStatus: ModelSupportInvestigationRecovery["status"] | "not-recorded",
  readinessOverall: ModelSupportInvestigationEvidenceReadinessReport["overall"],
  availableFileCount: number,
  requiredCoreFiles: string[],
  missingRequiredCoreFiles: string[],
  referencedEvidencePathCount: number,
  missingReferencedEvidencePaths: string[],
  readyDomainIds: ModelSupportInvestigationEvidenceDomainId[],
  partialDomainIds: ModelSupportInvestigationEvidenceDomainId[],
  insufficientDomainIds: ModelSupportInvestigationEvidenceDomainId[],
  notObservedDomainIds: ModelSupportInvestigationEvidenceDomainId[],
  unresolvedAssessmentIds: string[],
  limitations: string[],
}

export interface ModelSupportInvestigationProgressObservation {
  kind: "model-load",
  candidateId: string,
  sourceStatus: string,
  currentFile: string | undefined,
  fileLoaded: number | undefined,
  fileTotal: number | undefined,
  fileProgress: number | undefined,
  aggregateLoaded: number | undefined,
  aggregateTotal: number | undefined,
  aggregateProgress: number | undefined,
  eventCount: number,
  progressEventCount: number,
  progressTotalEventCount: number,
  forwardProgressCount: number,
  repeatedWithoutForwardProgressCount: number,
  lastActivityAt: string,
  lastForwardProgressAt: string | undefined,
}

export interface ModelSupportInvestigationEvent {
  stepId: ModelSupportInvestigationStepId,
  status: ModelSupportInvestigationStepStatus,
  detail: string,
  progress?: ModelSupportInvestigationProgressObservation,
}

export interface ModelSupportInvestigationRecordedEvent extends ModelSupportInvestigationEvent {
  sequence: number,
  at: string,
}

export interface ModelSupportInvestigationRecovery {
  schemaVersion: 1,
  status: "running" | "completed" | "interrupted",
  checkpointSequence: number,
  checkpointedAt: string,
  lastEvent: ModelSupportInvestigationRecordedEvent | undefined,
  events: ModelSupportInvestigationRecordedEvent[],
  interruption: {
    at: string,
    lastEventSequence: number | undefined,
    error: ModelSupportInvestigationLoadAttemptError,
  } | undefined,
}

export interface ModelSupportInvestigationCheckpoint {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery,
}

export interface IModelSupportInvestigationWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks must be top-level arguments; nested proxy callbacks are not structured-cloneable.
  runPartialInvestigation(
    modelId: string,
    onEvent: WorkerProxy<({ event }: { event: ModelSupportInvestigationEvent }) => void>,
    onRunCheckpoint: WorkerProxy<({ run }: { run: ModelSupportInvestigationPlanningWorkerRun }) => void>,
  ): Promise<ModelSupportInvestigationPlanningWorkerRun>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks must be top-level arguments; nested proxy callbacks are not structured-cloneable.
  runCandidateAttempt(
    repository: ModelSupportInvestigationRepository,
    declarations: ModelSupportInvestigationModelDeclarations,
    templateBehavior: ModelSupportInvestigationTemplateBehavior | undefined,
    cacheRevisionAliases: import('@/features/transformers-js/types').TransformersJsCacheRevisionAlias[],
    candidate: ModelSupportInvestigationCandidateFilePlan,
    onEvent: WorkerProxy<({ event }: { event: ModelSupportInvestigationEvent }) => void>,
    onAttemptEvent: WorkerProxy<({ event }: { event: ModelSupportInvestigationLoadAttemptEvent }) => void>,
    onAttemptCheckpoint: WorkerProxy<({ attempt }: { attempt: ModelSupportInvestigationLoadAttemptCheckpoint }) => void>,
  ): Promise<ModelSupportInvestigationLoadAttempt>,
}

export interface ModelSupportInvestigationWorkerClient {
  runPartialInvestigation({ modelId, onEvent, onCheckpoint }: {
    modelId: string,
    onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
    onCheckpoint: ({ checkpoint }: { checkpoint: ModelSupportInvestigationCheckpoint }) => void,
  }): Promise<ModelSupportInvestigationRun>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
