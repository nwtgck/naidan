import { expectedObservableState } from "./model/reference-filesystem-model";
import {
  sparseAndReflinkScenario,
  symlinkScenario,
  writerMutationScenario,
} from "./scenarios/representative-filesystem";
import {
  applyScenario,
  createWritableScenarioSession,
  observeObservableState,
  openFreshReadOnlySession,
} from "./support/hizofs-test-environment";
import { describe, expect, it } from "vitest";

for (const scenario of [writerMutationScenario, sparseAndReflinkScenario, symlinkScenario]) {
  describe(`HizoFS V1 crash consistency after sync: ${scenario.id}`, () => {
    it("reopens exactly the acknowledged state after discarding all non-durable backend state", async () => {
      const writable = await createWritableScenarioSession();
      try {
        await applyScenario({ scenario, session: writable.session });
        await writable.session.sync();

        await writable.backend.crashAndRecover();

        const fresh = await openFreshReadOnlySession({
          backend: writable.backend,
          expectedFileSystemId: writable.fileSystemId,
          passphrase: writable.passphrase,
        });
        let observationSucceeded = false;
        try {
          expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario }));
          observationSucceeded = true;
        } finally {
          if (observationSucceeded) await fresh.close();
          else await fresh.close().catch(() => undefined);
        }
      } finally {
        await writable.session.close().catch(() => undefined);
      }
    });
  });
}
