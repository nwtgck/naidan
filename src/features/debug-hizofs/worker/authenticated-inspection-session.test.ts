import { describe, expect, it, vi } from "vitest";
import { bindHizoFSPhysicalInspectionWorkerPassphrase } from "./authenticated-inspection-session";
import type { HizoFSPhysicalInspectionWorker } from "./physical-inspection";

describe("HizoFS authenticated inspection session", () => {
  it("keeps the passphrase outside the UI-facing session shape", async () => {
    const inspectContainer = vi.fn(async () => ({ marker: "container" }) as never);
    const inspectNamespacePath = vi.fn(async () => ({ marker: "namespace" }) as never);
    const inspectHomeRecord = vi.fn(async () => ({ marker: "home" }) as never);
    const inspectRecord = vi.fn(async () => ({ marker: "record" }) as never);
    const inspectRecordFrame = vi.fn(async () => ({ marker: "frame" }) as never);
    const worker: HizoFSPhysicalInspectionWorker = {
      inspectContainer,
      inspectHomeRecord,
      inspectNamespacePath,
      inspectRecord,
      inspectRecordFrame,
    };

    const session = bindHizoFSPhysicalInspectionWorkerPassphrase({
      passphrase: "temporary secret",
      worker,
    });

    expect(Object.keys(session).sort()).toEqual([
      "inspectContainer",
      "inspectHomeRecord",
      "inspectNamespacePath",
      "inspectRecord",
      "inspectRecordFrame",
    ]);
    await session.inspectContainer();
    await session.inspectNamespacePath({ pathComponents: ["docs"] });
    await session.inspectRecordFrame({ request: {} as never });

    expect(inspectContainer).toHaveBeenCalledWith({ passphrase: "temporary secret" });
    expect(inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: undefined,
      maximumPages: undefined,
      passphrase: "temporary secret",
      pathComponents: ["docs"],
    });
    expect(inspectRecordFrame).toHaveBeenCalledWith({
      passphrase: "temporary secret",
      request: {},
    });
  });
});
