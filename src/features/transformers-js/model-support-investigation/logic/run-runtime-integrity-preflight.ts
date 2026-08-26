import type {
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationRuntimeAssets,
  ModelSupportInvestigationRuntimeControl,
  ModelSupportInvestigationRuntimeEnvironment,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationWebGpuRuntimeControl,
} from "@/features/transformers-js/model-support-investigation/types";
import type { HostedTransformersRuntimeAssetUrls } from "@/features/transformers-js/runtime/configure-hosted-runtime";

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

function hasWasmMagic({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x00
    && bytes[1] === 0x61
    && bytes[2] === 0x73
    && bytes[3] === 0x6d;
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
  onEvent,
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
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  createRunId: () => string,
  now: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const runId = createRunId();
  const startedAt = now();
  const emit = ({ status, detail }: {
    status: ModelSupportInvestigationEvent["status"],
    detail: string,
  }): void => onEvent({ event: { stepId: "runtime-assets", status, detail } });

  emit({ status: "running", detail: "Checking same-origin runtime asset URLs" });

  try {
    const mjsOrigin = new URL(assets.mjsUrl).origin;
    const wasmOrigin = new URL(assets.wasmUrl).origin;
    const physicalWasmOrigin = new URL(assets.physicalWasmUrl).origin;
    if (
      mjsOrigin !== applicationOrigin
      || wasmOrigin !== applicationOrigin
      || physicalWasmOrigin !== applicationOrigin
    ) {
      throw new Error("ONNX Runtime assets are not configured for the Naidan origin");
    }

    emit({ status: "running", detail: "Collecting browser and WebGPU environment evidence" });
    const environment = await inspectEnvironment();

    emit({ status: "running", detail: "Importing the same-origin ONNX Runtime module" });
    await importRuntimeModule({ url: assets.mjsUrl });

    emit({ status: "running", detail: "Fetching the same-origin ONNX Runtime WASM" });
    const response = await runtimeFetch(assets.wasmUrl);
    if (!response.ok) {
      throw new Error(`ONNX Runtime WASM request failed: ${response.status} ${response.statusText}`);
    }
    if (response.headers.get("content-type") !== "application/wasm") {
      throw new Error("ONNX Runtime WASM logical response has an invalid Content-Type");
    }

    const wasmBytes = new Uint8Array(await response.arrayBuffer());
    if (!hasWasmMagic({ bytes: wasmBytes })) {
      throw new Error("ONNX Runtime WASM response does not contain a valid WebAssembly header");
    }

    emit({ status: "running", detail: "Creating and running a fixed ONNX Runtime WASM control session" });
    const control = await runWasmControl();
    if (control.outputValue !== control.inputValue) {
      throw new Error(`ONNX Runtime WASM control returned an unexpected value: ${control.outputValue}`);
    }

    emit({ status: "running", detail: "Creating and running a fixed ONNX Runtime WebGPU control session when available" });
    let webGpuControl: ModelSupportInvestigationWebGpuRuntimeControl;
    try {
      webGpuControl = await runWebGpuControl();
    } catch (error) {
      webGpuControl = {
        fixtureId: "identity-float32-v1",
        fixtureSha256: control.fixtureSha256,
        executionProvider: "webgpu",
        status: "failed",
        inputName: "x",
        outputName: "y",
        inputValue: 7,
        outputValue: undefined,
        error: errorMessage({ error }),
      };
    }

    const runtimeAssets: ModelSupportInvestigationRuntimeAssets = {
      variant: assets.variant,
      baseUrl: assets.baseUrl,
      mjsUrl: assets.mjsUrl,
      wasmUrl: assets.wasmUrl,
      wasmByteLength: wasmBytes.byteLength,
      mjsOrigin,
      wasmOrigin,
      applicationOrigin,
      environment,
      control,
      webGpuControl,
    };
    const detail = "Same-origin ONNX Runtime module, WASM, and control inference verified";
    emit({ status: "passed", detail });

    return {
      schemaVersion: 1,
      runId,
      modelId,
      scope: "partial-runtime-preflight",
      startedAt,
      completedAt: now(),
      status: "passed",
      currentOperation: detail,
      steps: [
        { id: "runtime-assets", status: "passed", detail },
        ...NOT_RUN_STEPS,
      ],
      runtimeAssets,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, error: undefined },
      laneComparison: undefined,
      error: undefined,
    };
  } catch (error) {
    const message = errorMessage({ error });
    emit({ status: "failed", detail: message });
    return {
      schemaVersion: 1,
      runId,
      modelId,
      scope: "partial-runtime-preflight",
      startedAt,
      completedAt: now(),
      status: "failed",
      currentOperation: message,
      steps: [
        { id: "runtime-assets", status: "failed", detail: message },
        ...NOT_RUN_STEPS,
      ],
      runtimeAssets: undefined,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, error: undefined },
      laneComparison: undefined,
      error: message,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
