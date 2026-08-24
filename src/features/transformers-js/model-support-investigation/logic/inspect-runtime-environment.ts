import type { ModelSupportInvestigationRuntimeEnvironment } from "@/features/transformers-js/model-support-investigation/types";

interface WebGpuAdapterLike {
  info?: unknown,
  features?: Iterable<string>,
  limits?: object,
}

interface NavigatorLike {
  userAgent?: string,
  vendor?: string,
  hardwareConcurrency?: number,
  deviceMemory?: number,
  gpu?: { requestAdapter: () => Promise<WebGpuAdapterLike | null> },
}

const LIMIT_NAMES = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupsPerDimension",
] as const;

function adapterInfoRecord({ value }: { value: unknown }): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(["vendor", "architecture", "device", "description"]
    .flatMap(key => typeof record[key] === "string" ? [[key, record[key]]] : []));
}

function limitsRecord({ value }: { value: object | undefined }): Record<string, number> {
  if (value === undefined) return {};
  const knownLimits = value as Partial<Record<(typeof LIMIT_NAMES)[number], unknown>>;
  return Object.fromEntries(LIMIT_NAMES.flatMap(key => typeof knownLimits[key] === "number" ? [[key, knownLimits[key]]] : []));
}

export async function inspectRuntimeEnvironment({
  navigatorValue,
  crossOriginIsolatedValue,
}: {
  navigatorValue: NavigatorLike,
  crossOriginIsolatedValue: boolean,
}): Promise<ModelSupportInvestigationRuntimeEnvironment> {
  const base = {
    userAgent: navigatorValue.userAgent ?? "",
    vendor: navigatorValue.vendor ?? "",
    hardwareConcurrency: navigatorValue.hardwareConcurrency ?? 0,
    deviceMemoryGiB: navigatorValue.deviceMemory,
    crossOriginIsolated: crossOriginIsolatedValue,
  };
  if (navigatorValue.gpu === undefined) {
    return {
      ...base,
      webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
    };
  }
  try {
    const adapter = await navigatorValue.gpu.requestAdapter();
    if (adapter === null) {
      return {
        ...base,
        webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
      };
    }
    return {
      ...base,
      webGpu: {
        availability: "available",
        adapterInfo: adapterInfoRecord({ value: adapter.info }),
        features: adapter.features === undefined ? [] : [...adapter.features].sort((a, b) => a.localeCompare(b)),
        limits: limitsRecord({ value: adapter.limits }),
        error: undefined,
      },
    };
  } catch (error) {
    return {
      ...base,
      webGpu: {
        availability: "request-failed",
        adapterInfo: {},
        features: [],
        limits: {},
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
