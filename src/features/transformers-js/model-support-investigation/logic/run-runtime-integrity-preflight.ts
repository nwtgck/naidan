import type {
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationLoadAttemptError,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationRuntimeAssets,
  ModelSupportInvestigationRuntimeAssetsPartial,
  ModelSupportInvestigationRuntimeControl,
  ModelSupportInvestigationRuntimeEnvironment,
  ModelSupportInvestigationRuntimePreflightStage,
  ModelSupportInvestigationRuntimePreflightStageObservation,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationWebGpuRuntimeControl,
} from "@/features/transformers-js/model-support-investigation/types";
import type { HostedTransformersRuntimeAssetUrls } from "@/features/transformers-js/runtime/configure-hosted-runtime";
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from "@/features/transformers-js/runtime/runtime-asset-manifest";
import { z } from "zod";
import {
  RUNTIME_CONTROL_FIXTURE_ID,
  RUNTIME_CONTROL_FIXTURE_SHA256,
} from "@/features/transformers-js/model-support-investigation/fixtures/runtime-control-model";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

const NOT_RUN_STEPS: ModelSupportInvestigationStep[] = [
  { id: "repository-information", status: "not-run", detail: undefined },
  { id: "existing-model-data", status: "not-run", detail: undefined },
  { id: "model-declarations", status: "not-run", detail: undefined },
  { id: "template-behavior", status: "not-run", detail: undefined },
  { id: "model-file-plan", status: "not-run", detail: undefined },
  { id: "loading-investigation", status: "not-run", detail: undefined },
  { id: "lane-comparison", status: "not-run", detail: undefined },
  { id: "evidence-export", status: "not-run", detail: undefined },
];

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

const runtimeAssetManifestEntrySchema = z.object({
  variant: z.enum(["standard", "asyncify"]),
  sourceMjsFileName: z.string(),
  sourceWasmFileName: z.string(),
  mjs: z.object({
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    publicFileName: z.string(),
  }).strict(),
  wasm: z.object({
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    logicalFileName: z.string(),
    physicalByteLength: z.number().int().nonnegative(),
    physicalSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    physicalFileName: z.string(),
  }).strict(),
}).strict();

const runtimeAssetManifestResponseSchema = z.object({
  schemaVersion: z.literal(1),
  buildId: z.string().regex(/^[0-9a-f]{64}$/u),
  versions: z.object({
    transformers: z.string(),
    onnxRuntimeWeb: z.string(),
    onnxRuntimeCommon: z.string(),
    onnxRuntimeWebBundledCommon: z.string(),
  }).strict(),
  variants: z.array(runtimeAssetManifestEntrySchema),
}).strict();

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function isJavaScriptContentType({ contentType }: { contentType: string | null }): boolean {
  if (contentType === null) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("javascript") || normalized.includes("ecmascript");
}

function hasWasmMagic({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x00
    && bytes[1] === 0x61
    && bytes[2] === 0x73
    && bytes[3] === 0x6d;
}

function createRuntimeRun({
  runId,
  modelId,
  startedAt,
  completedAt,
  status,
  stepStatus,
  detail,
  error,
  runtimeAssets,
  runtimeAssetsPartial,
  structuredFailures,
}: {
  runId: string,
  modelId: string,
  startedAt: string,
  completedAt: string,
  status: ModelSupportInvestigationRun["status"],
  stepStatus: ModelSupportInvestigationStep["status"],
  detail: string,
  error: string | undefined,
  runtimeAssets: ModelSupportInvestigationRuntimeAssets | undefined,
  runtimeAssetsPartial: ModelSupportInvestigationRuntimeAssetsPartial | undefined,
  structuredFailures: ModelSupportInvestigationLoadAttemptError[],
}): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1,
    runId,
    modelId,
    scope: "partial-runtime-preflight",
    startedAt,
    completedAt,
    status,
    currentOperation: detail,
    steps: [
      { id: "runtime-assets", status: stepStatus, detail },
      ...NOT_RUN_STEPS,
    ],
    runtimeAssets,
    runtimeAssetsPartial,
    stepErrors: structuredFailures.length === 0
      ? undefined
      : { "runtime-assets": structuredClone(structuredFailures) },
    repository: undefined,
    cache: undefined,
    declarations: undefined,
    templateBehavior: undefined,
    modelFilePlan: undefined,
    loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
    error,
  };
}

function setStageObservation({
  partial,
  observation,
}: {
  partial: ModelSupportInvestigationRuntimeAssetsPartial,
  observation: ModelSupportInvestigationRuntimePreflightStageObservation,
}): void {
  partial.stageObservations = [
    ...partial.stageObservations.filter(item => item.stage !== observation.stage),
    observation,
  ];
  partial.currentStage = undefined;
}

export async function runRuntimeIntegrityPreflight({
  modelId,
  assets,
  applicationOrigin,
  runtimeFetch,
  importRuntimeModule,
  runWasmControl,
  runWebGpuControl,
  inspectEnvironment,
  inspectWasmConfiguration,
  onEvent,
  onRunUpdate,
  createRunId,
  now,
}: {
  modelId: string,
  assets: HostedTransformersRuntimeAssetUrls,
  applicationOrigin: string,
  runtimeFetch: typeof fetch,
  importRuntimeModule: ({ url }: { url: string }) => Promise<void>,
  runWasmControl: () => Promise<ModelSupportInvestigationRuntimeControl>,
  runWebGpuControl: () => Promise<ModelSupportInvestigationWebGpuRuntimeControl>,
  inspectEnvironment: () => Promise<ModelSupportInvestigationRuntimeEnvironment>,
  inspectWasmConfiguration?: () => { numThreads: number | undefined, proxy: boolean | undefined },
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  onRunUpdate?: ({ run }: { run: ModelSupportInvestigationRun }) => void,
  createRunId: () => string,
  now: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const runId = createRunId();
  const startedAt = now();
  const failures: string[] = [];
  const structuredFailures: ModelSupportInvestigationLoadAttemptError[] = [];
  const partial: ModelSupportInvestigationRuntimeAssetsPartial = {
    variant: assets.variant,
    assetIdentity: {
      manifestBuildId: assets.manifestBuildId,
      manifestUrl: assets.manifestUrl,
      observedManifestBuildId: assets.manifestUrl === undefined ? assets.manifestBuildId : undefined,
      versions: { ...HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.versions },
      mjs: {
        url: assets.mjsUrl,
        expectedByteLength: assets.mjsByteLength,
        observedByteLength: undefined,
        expectedSha256: assets.mjsSha256,
        observedSha256: undefined,
      },
      wasm: {
        logicalUrl: assets.wasmUrl,
        physicalUrl: assets.physicalWasmUrl,
        expectedByteLength: assets.wasmByteLength,
        observedByteLength: undefined,
        expectedSha256: assets.wasmSha256,
        observedSha256: undefined,
        expectedPhysicalByteLength: assets.physicalWasmByteLength,
        observedPhysicalByteLength: undefined,
        expectedPhysicalSha256: assets.physicalWasmSha256,
        observedPhysicalSha256: undefined,
      },
    },
    baseUrl: assets.baseUrl,
    mjsUrl: assets.mjsUrl,
    wasmUrl: assets.wasmUrl,
    physicalWasmUrl: assets.physicalWasmUrl,
    applicationOrigin,
    mjsOrigin: undefined,
    wasmOrigin: undefined,
    physicalWasmOrigin: undefined,
    environment: undefined,
    wasmByteLength: undefined,
    control: undefined,
    webGpuControl: undefined,
    currentStage: undefined,
    stageObservations: [],
  };
  if (inspectWasmConfiguration !== undefined) {
    try {
      const configuration = inspectWasmConfiguration();
      partial.threading = {
        requestedThreads: configuration.numThreads,
        effectiveThreads: undefined,
        effectiveThreadsBasis: "unavailable",
        proxy: configuration.proxy,
        childWorkerLifecycle: "not-observed",
        childWorkerLifecycleReason: "The browser and ONNX Runtime public APIs do not expose Emscripten pthread worker lifecycle events without replacing the global Worker constructor",
      };
    } catch {
      partial.threading = {
        requestedThreads: undefined,
        effectiveThreads: undefined,
        effectiveThreadsBasis: "unavailable",
        proxy: undefined,
        childWorkerLifecycle: "not-observed",
        childWorkerLifecycleReason: "WASM thread configuration could not be read before the control run",
      };
    }
  }

  const emit = ({ status, detail }: {
    status: ModelSupportInvestigationEvent["status"],
    detail: string,
  }): void => onEvent({ event: { stepId: "runtime-assets", status, detail } });
  const publishPartial = ({ stage, detail }: {
    stage: ModelSupportInvestigationRuntimePreflightStage,
    detail: string,
  }): void => {
    partial.currentStage = stage;
    onRunUpdate?.({
      run: createRuntimeRun({
        runId,
        modelId,
        startedAt,
        completedAt: now(),
        status: failures.length === 0 ? "passed" : "failed",
        stepStatus: "running",
        detail,
        error: failures.length === 0 ? undefined : failures.join("; "),
        runtimeAssets: undefined,
        runtimeAssetsPartial: structuredClone(partial),
        structuredFailures,
      }),
    });
  };
  const finishStage = ({ observation, error }: {
    observation: ModelSupportInvestigationRuntimePreflightStageObservation,
    error: unknown | undefined,
  }): void => {
    setStageObservation({ partial, observation });
    switch (observation.status) {
    case "failed":
      failures.push(observation.error);
      structuredFailures.push(serializeInvestigationError({
        error: error ?? new Error(observation.error),
      }));
      break;
    case "not-run":
    case "passed":
      break;
    default: {
      const _ex: never = observation;
      throw new Error(`Unhandled runtime preflight stage status: ${((_ex satisfies never) as { readonly status: string }).status}`);
    }
    }
    onRunUpdate?.({
      run: createRuntimeRun({
        runId,
        modelId,
        startedAt,
        completedAt: now(),
        status: failures.length === 0 ? "passed" : "failed",
        stepStatus: "running",
        detail: observation.detail,
        error: failures.length === 0 ? undefined : failures.join("; "),
        runtimeAssets: undefined,
        runtimeAssetsPartial: structuredClone(partial),
        structuredFailures,
      }),
    });
  };

  emit({ status: "running", detail: "Checking same-origin runtime asset URLs" });
  publishPartial({ stage: "origin-validation", detail: "Checking same-origin runtime asset URLs" });
  let originSafe = false;
  try {
    partial.mjsOrigin = new URL(assets.mjsUrl).origin;
    partial.wasmOrigin = new URL(assets.wasmUrl).origin;
    partial.physicalWasmOrigin = new URL(assets.physicalWasmUrl).origin;
    originSafe = partial.mjsOrigin === applicationOrigin
      && partial.wasmOrigin === applicationOrigin
      && partial.physicalWasmOrigin === applicationOrigin;
    if (!originSafe) throw new Error("ONNX Runtime assets are not configured for the Naidan origin");
    finishStage({ observation: { stage: "origin-validation", status: "passed", detail: "All ONNX Runtime asset URLs are same-origin" }, error: undefined });
  } catch (error) {
    const message = errorMessage({ error });
    finishStage({ observation: { stage: "origin-validation", status: "failed", detail: message, error: message }, error });
  }

  emit({ status: "running", detail: "Collecting browser and WebGPU environment evidence" });
  publishPartial({ stage: "environment", detail: "Collecting browser and WebGPU environment evidence" });
  try {
    partial.environment = await inspectEnvironment();
    finishStage({ observation: { stage: "environment", status: "passed", detail: "Browser and WebGPU environment evidence collected" }, error: undefined });
  } catch (error) {
    const message = errorMessage({ error });
    finishStage({ observation: { stage: "environment", status: "failed", detail: message, error: message }, error });
  }

  if (!originSafe) {
    const reason = "Not run because same-origin runtime asset validation failed";
    for (const stage of ["module-import", "wasm-fetch", "wasm-validation", "wasm-control", "webgpu-control"] as const) {
      finishStage({ observation: { stage, status: "not-run", detail: reason, reason }, error: undefined });
    }
    const detail = failures[0] ?? "Runtime preflight failed";
    emit({ status: "failed", detail });
    return createRuntimeRun({
      runId,
      modelId,
      startedAt,
      completedAt: now(),
      status: "failed",
      stepStatus: "failed",
      detail,
      error: failures.join("; "),
      runtimeAssets: undefined,
      runtimeAssetsPartial: partial,
      structuredFailures,
    });
  }

  emit({ status: "running", detail: "Verifying and importing the same-origin ONNX Runtime module" });
  publishPartial({ stage: "module-import", detail: "Verifying and importing the same-origin ONNX Runtime module" });
  try {
    if (assets.manifestUrl !== undefined) {
      const manifestResponse = await runtimeFetch(assets.manifestUrl);
      if (!manifestResponse.ok) {
        throw new Error(`ONNX Runtime asset manifest request failed: ${manifestResponse.status} ${manifestResponse.statusText}`);
      }
      const manifestContentType = manifestResponse.headers.get("content-type");
      if (manifestContentType?.toLowerCase().includes("application/json") !== true) {
        throw new Error(`ONNX Runtime asset manifest has an invalid Content-Type: ${manifestContentType ?? "missing"}`);
      }
      const manifest = runtimeAssetManifestResponseSchema.parse(JSON.parse(await manifestResponse.text()) as unknown);
      if (manifest.buildId !== assets.manifestBuildId) {
        throw new Error(`ONNX Runtime asset manifest build ID mismatch: expected ${assets.manifestBuildId}, observed ${manifest.buildId}`);
      }
      if (JSON.stringify(manifest) !== JSON.stringify(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST)) {
        throw new Error("ONNX Runtime asset manifest does not match the compiled runtime manifest");
      }
      partial.assetIdentity!.observedManifestBuildId = manifest.buildId;
    }

    const mjsResponse = await runtimeFetch(assets.mjsUrl);
    if (!mjsResponse.ok) throw new Error(`ONNX Runtime MJS request failed: ${mjsResponse.status} ${mjsResponse.statusText}`);
    const mjsContentType = mjsResponse.headers.get("content-type");
    if (!isJavaScriptContentType({ contentType: mjsContentType })) {
      throw new Error(`ONNX Runtime MJS asset has an invalid Content-Type: ${mjsContentType ?? "missing"}`);
    }
    const mjsBytes = new Uint8Array(await mjsResponse.arrayBuffer());
    const mjsSha256 = await sha256Hex({ bytes: mjsBytes });
    partial.assetIdentity!.mjs.observedByteLength = mjsBytes.byteLength;
    partial.assetIdentity!.mjs.observedSha256 = mjsSha256;
    if (mjsBytes.byteLength !== assets.mjsByteLength || mjsSha256 !== assets.mjsSha256) {
      throw new Error(`ONNX Runtime MJS fingerprint mismatch for ${assets.mjsUrl}`);
    }

    await importRuntimeModule({ url: assets.mjsUrl });
    finishStage({ observation: { stage: "module-import", status: "passed", detail: "Same-origin ONNX Runtime manifest and module fingerprints verified" }, error: undefined });
  } catch (error) {
    const message = errorMessage({ error });
    finishStage({ observation: { stage: "module-import", status: "failed", detail: message, error: message }, error });
  }

  let wasmBytes: Uint8Array | undefined;
  emit({ status: "running", detail: "Fetching the same-origin ONNX Runtime WASM" });
  publishPartial({ stage: "wasm-fetch", detail: "Fetching the same-origin ONNX Runtime WASM" });
  try {
    if (assets.physicalWasmUrl !== assets.wasmUrl) {
      const physicalResponse = await runtimeFetch(assets.physicalWasmUrl);
      if (!physicalResponse.ok) {
        throw new Error(`ONNX Runtime physical WASM request failed: ${physicalResponse.status} ${physicalResponse.statusText}`);
      }
      const physicalContentEncoding = physicalResponse.headers.get("content-encoding");
      if (physicalContentEncoding !== null && physicalContentEncoding !== "identity") {
        throw new Error(`Unexpected Content-Encoding for ONNX Runtime physical WASM asset: ${physicalContentEncoding}`);
      }
      const physicalBytes = new Uint8Array(await physicalResponse.arrayBuffer());
      const physicalSha256 = await sha256Hex({ bytes: physicalBytes });
      partial.assetIdentity!.wasm.observedPhysicalByteLength = physicalBytes.byteLength;
      partial.assetIdentity!.wasm.observedPhysicalSha256 = physicalSha256;
      if (physicalBytes.byteLength !== assets.physicalWasmByteLength || physicalSha256 !== assets.physicalWasmSha256) {
        throw new Error(`ONNX Runtime physical WASM fingerprint mismatch for ${assets.physicalWasmUrl}`);
      }
    }

    const response = await runtimeFetch(assets.wasmUrl);
    if (!response.ok) throw new Error(`ONNX Runtime WASM request failed: ${response.status} ${response.statusText}`);
    if (response.headers.get("content-type") !== "application/wasm") {
      throw new Error("ONNX Runtime WASM logical response has an invalid Content-Type");
    }
    wasmBytes = new Uint8Array(await response.arrayBuffer());
    const wasmSha256 = await sha256Hex({ bytes: wasmBytes });
    partial.wasmByteLength = wasmBytes.byteLength;
    partial.assetIdentity!.wasm.observedByteLength = wasmBytes.byteLength;
    partial.assetIdentity!.wasm.observedSha256 = wasmSha256;
    if (wasmBytes.byteLength !== assets.wasmByteLength || wasmSha256 !== assets.wasmSha256) {
      throw new Error(`ONNX Runtime WASM fingerprint mismatch for ${assets.wasmUrl}`);
    }
    if (assets.physicalWasmUrl === assets.wasmUrl) {
      partial.assetIdentity!.wasm.observedPhysicalByteLength = wasmBytes.byteLength;
      partial.assetIdentity!.wasm.observedPhysicalSha256 = wasmSha256;
    }
    finishStage({ observation: { stage: "wasm-fetch", status: "passed", detail: `Fetched and fingerprint-verified ${wasmBytes.byteLength} WASM bytes` }, error: undefined });
  } catch (error) {
    const message = errorMessage({ error });
    finishStage({ observation: { stage: "wasm-fetch", status: "failed", detail: message, error: message }, error });
  }

  if (wasmBytes === undefined) {
    const reason = "Not run because the runtime WASM bytes were unavailable";
    finishStage({ observation: { stage: "wasm-validation", status: "not-run", detail: reason, reason }, error: undefined });
  } else {
    publishPartial({ stage: "wasm-validation", detail: "Validating the runtime WASM header" });
    if (hasWasmMagic({ bytes: wasmBytes })) {
      finishStage({ observation: { stage: "wasm-validation", status: "passed", detail: "Runtime WASM has a valid WebAssembly header" }, error: undefined });
    } else {
      const message = "ONNX Runtime WASM response does not contain a valid WebAssembly header";
      finishStage({ observation: { stage: "wasm-validation", status: "failed", detail: message, error: message }, error: new Error(message) });
    }
  }

  emit({ status: "running", detail: "Creating and running a fixed ONNX Runtime WASM control session" });
  publishPartial({ stage: "wasm-control", detail: "Creating and running a fixed ONNX Runtime WASM control session" });
  try {
    const observedControl = await runWasmControl();
    switch (observedControl.status) {
    case "failed":
      partial.control = observedControl;
      finishStage({
        observation: { stage: "wasm-control", status: "failed", detail: observedControl.error, error: observedControl.error },
        error: new Error(observedControl.error),
      });
      break;
    case "passed":
      if (observedControl.outputValue !== observedControl.inputValue) {
        const message = `ONNX Runtime WASM control returned an unexpected value: ${observedControl.outputValue}`;
        partial.control = { ...observedControl, status: "failed", error: message };
        finishStage({ observation: { stage: "wasm-control", status: "failed", detail: message, error: message }, error: new Error(message) });
      } else {
        partial.control = observedControl;
        finishStage({ observation: { stage: "wasm-control", status: "passed", detail: "WASM control inference passed" }, error: undefined });
      }
      break;
    default: {
      const _ex: never = observedControl;
      throw new Error(`Unhandled WASM control status: ${((_ex satisfies never) as { readonly status: string }).status}`);
    }
    }
  } catch (error) {
    const message = errorMessage({ error });
    partial.control = {
      fixtureId: RUNTIME_CONTROL_FIXTURE_ID,
      fixtureSha256: RUNTIME_CONTROL_FIXTURE_SHA256,
      executionProvider: "wasm",
      status: "failed",
      inputName: "x",
      outputName: "y",
      inputValue: 7,
      outputValue: undefined,
      error: message,
    };
    finishStage({ observation: { stage: "wasm-control", status: "failed", detail: message, error: message }, error });
  }

  if (inspectWasmConfiguration !== undefined && partial.threading !== undefined) {
    try {
      const configuration = inspectWasmConfiguration();
      partial.threading = {
        ...partial.threading,
        effectiveThreads: configuration.numThreads,
        effectiveThreadsBasis: configuration.numThreads === undefined ? "unavailable" : "runtime-env-after-control",
        proxy: configuration.proxy,
      };
    } catch {
      // Thread observation is diagnostic-only; do not alter the runtime control result.
    }
  }

  emit({ status: "running", detail: "Creating and running a fixed ONNX Runtime WebGPU control session when available" });
  publishPartial({ stage: "webgpu-control", detail: "Creating and running a fixed ONNX Runtime WebGPU control session when available" });
  try {
    const webGpuControl = await runWebGpuControl();
    partial.webGpuControl = webGpuControl;
    const webGpuStatus = webGpuControl.status;
    switch (webGpuStatus) {
    case "passed":
      finishStage({ observation: { stage: "webgpu-control", status: "passed", detail: "WebGPU control inference passed" }, error: undefined });
      break;
    case "not-available":
      finishStage({ observation: { stage: "webgpu-control", status: "passed", detail: "WebGPU control was not available in this environment" }, error: undefined });
      break;
    case "failed":
      finishStage({
        observation: { stage: "webgpu-control", status: "failed", detail: webGpuControl.error ?? "WebGPU control failed", error: webGpuControl.error ?? "WebGPU control failed" },
        error: new Error(webGpuControl.error ?? "WebGPU control failed"),
      });
      break;
    default: {
      const _ex: never = webGpuStatus;
      throw new Error(`Unhandled WebGPU control status: ${_ex}`);
    }
    }
  } catch (error) {
    const message = errorMessage({ error });
    partial.webGpuControl = {
      fixtureId: RUNTIME_CONTROL_FIXTURE_ID,
      fixtureSha256: RUNTIME_CONTROL_FIXTURE_SHA256,
      executionProvider: "webgpu",
      status: "failed",
      inputName: "x",
      outputName: "y",
      inputValue: 7,
      outputValue: undefined,
      error: message,
    };
    finishStage({ observation: { stage: "webgpu-control", status: "failed", detail: message, error: message }, error });
  }

  const requiredStages = ["origin-validation", "environment", "module-import", "wasm-fetch", "wasm-validation", "wasm-control"] as const;
  const requiredPassed = requiredStages.every(stage => partial.stageObservations.some(item => item.stage === stage && item.status === "passed"));
  const structuralStages = ["origin-validation", "environment", "module-import", "wasm-fetch", "wasm-validation"] as const;
  const structuralPassed = structuralStages.every(stage => partial.stageObservations.some(item => item.stage === stage && item.status === "passed"));
  const canBuildCompleteAssets = structuralPassed
    && partial.mjsOrigin !== undefined
    && partial.wasmOrigin !== undefined
    && partial.environment !== undefined
    && partial.wasmByteLength !== undefined
    && partial.control !== undefined
    && partial.webGpuControl !== undefined;
  const runtimeAssets: ModelSupportInvestigationRuntimeAssets | undefined = canBuildCompleteAssets
    ? {
      variant: partial.variant,
      assetIdentity: partial.assetIdentity,
      baseUrl: partial.baseUrl,
      mjsUrl: partial.mjsUrl,
      wasmUrl: partial.wasmUrl,
      wasmByteLength: partial.wasmByteLength!,
      mjsOrigin: partial.mjsOrigin!,
      wasmOrigin: partial.wasmOrigin!,
      applicationOrigin: partial.applicationOrigin,
      environment: partial.environment!,
      threading: partial.threading,
      control: partial.control!,
      webGpuControl: partial.webGpuControl!,
    }
    : undefined;
  const status: ModelSupportInvestigationRun["status"] = requiredPassed ? "passed" : "failed";
  const finalState = (() => {
    switch (status) {
    case "passed":
      return {
        detail: "Same-origin ONNX Runtime module, WASM, and control inference verified",
        error: undefined,
        runtimeAssetsPartial: undefined,
      };
    case "failed":
      return {
        detail: "Runtime preflight completed with partial or failed observations",
        error: failures.join("; "),
        runtimeAssetsPartial: partial,
      };
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled runtime preflight final status: ${_ex}`);
    }
    }
  })();
  emit({ status, detail: finalState.detail });

  return createRuntimeRun({
    runId,
    modelId,
    startedAt,
    completedAt: now(),
    status,
    stepStatus: status,
    detail: finalState.detail,
    error: finalState.error,
    runtimeAssets,
    runtimeAssetsPartial: finalState.runtimeAssetsPartial,
    structuredFailures,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
