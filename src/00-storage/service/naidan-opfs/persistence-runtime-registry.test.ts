import { describe, expect, it } from "vitest";

import type { OpfsPersistenceRuntime } from "@/00-storage/service/naidan-opfs/persistence-runtime-contract";
import {
  createInstalledOpfsPersistenceRuntime,
  installOpfsPersistenceRuntimeFactory,
  TEST_ONLY,
} from "@/00-storage/service/naidan-opfs/persistence-runtime-registry";

function runtime({ label }: { label: string }): OpfsPersistenceRuntime {
  return {
    writableProfile: 'development-unverified',
    runUnlockedMaintenance: async () => ({
      remainingEntryCount: 0,
      removedEntryCount: 0,
      state: 'completed' as const,
    }),
    changePassphrase: async () => {
      throw new Error(`${label}: not used`);
    },
    inspect: async () => ({ type: "plain" }),
    runStartupMaintenance: async () => {},
    runTransition: async () => {
      throw new Error(`${label}: not used`);
    },
    unlockWithPassphrase: async () => {
      throw new Error(`${label}: not used`);
    },
  };
}

describe("OPFS Persistence Control runtime registry", () => {
  it("fails closed while no runtime composition is installed", async () => {
    TEST_ONLY.reset();
    await expect(createInstalledOpfsPersistenceRuntime()).rejects.toThrow(
      "OPFS Persistence Control runtime is not connected",
    );
  });

  it("does not let stale cleanup remove a newer runtime factory", async () => {
    TEST_ONLY.reset();
    const first = runtime({ label: "first" });
    const second = runtime({ label: "second" });
    const uninstallFirst = installOpfsPersistenceRuntimeFactory({ factory: async () => first });
    const uninstallSecond = installOpfsPersistenceRuntimeFactory({ factory: async () => second });

    uninstallFirst();
    await expect(createInstalledOpfsPersistenceRuntime()).resolves.toBe(second);

    uninstallSecond();
    await expect(createInstalledOpfsPersistenceRuntime()).rejects.toThrow(
      "OPFS Persistence Control runtime is not connected",
    );
  });
});
