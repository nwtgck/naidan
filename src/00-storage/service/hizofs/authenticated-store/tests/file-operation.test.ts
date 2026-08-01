import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";
import { runAndCloseAuthenticatedFile } from "@/00-storage/service/hizofs/authenticated-store/file-operation";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";

async function fixture({ faultInjector }: { faultInjector?: DeterministicPhysicalStoreFaultInjector } = {}) {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
  const file = await backend.createFileExclusive({ path: canonicalContainerPath({ value: "close-test" }) });
  return { backend, file };
}

describe("authenticated writable-file operation", () => {
  for (const timing of ["before", "after"] as const) {
    it(`retries a close fault injected ${timing} handle release`, async () => {
      const injector = new DeterministicPhysicalStoreFaultInjector({
        schedule: [{ occurrence: 1, operation: "closeFile", timing }],
      });
      const value = await fixture({ faultInjector: injector });
      await expect(runAndCloseAuthenticatedFile({
        ...value,
        operation: async () => {},
        operationLabel: "test operation",
      })).rejects.toThrow("injected");
      expect(value.backend.openHandleCount()).toBe(0);
      injector.assertExhausted();
    });
  }

  it("does not lose an undefined rejection value", async () => {
    const value = await fixture();
    let rejected = false;
    try {
      await runAndCloseAuthenticatedFile({
        ...value,
        operation: async () => {
          throw undefined;
        },
        operationLabel: "undefined rejection test",
      });
    } catch (cause: unknown) {
      rejected = true;
      expect(cause).toBeUndefined();
    }
    expect(rejected).toBe(true);
    expect(value.backend.openHandleCount()).toBe(0);
  });
});
