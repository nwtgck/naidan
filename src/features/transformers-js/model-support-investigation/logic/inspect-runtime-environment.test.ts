import { describe, expect, it } from "vitest";
import { inspectRuntimeEnvironment } from "@/features/transformers-js/model-support-investigation/logic/inspect-runtime-environment";

describe("inspectRuntimeEnvironment", () => {
  it("records adapter identity, features, and selected numeric limits", async () => {
    const result = await inspectRuntimeEnvironment({
      navigatorValue: {
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemory: 16,
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: "GPU Vendor", architecture: "arch", ignored: 1 },
            features: new Set(["shader-f16", "timestamp-query"]),
            limits: { maxBufferSize: 1024, ignored: 3 },
          }),
        },
      },
      crossOriginIsolatedValue: true,
    });

    expect(result).toMatchObject({
      userAgent: "Browser/1",
      hardwareConcurrency: 8,
      deviceMemoryGiB: 16,
      crossOriginIsolated: true,
      webGpu: {
        availability: "available",
        adapterInfo: { vendor: "GPU Vendor", architecture: "arch" },
        features: ["shader-f16", "timestamp-query"],
        limits: { maxBufferSize: 1024 },
      },
    });
  });

  it("records request failure without throwing", async () => {
    const result = await inspectRuntimeEnvironment({
      navigatorValue: { gpu: { requestAdapter: async () => {
        throw new Error("adapter denied");
      } } },
      crossOriginIsolatedValue: false,
    });

    expect(result.webGpu).toMatchObject({ availability: "request-failed", error: "adapter denied" });
  });
});
