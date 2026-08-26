import { expectedObservableState } from "./model/reference-filesystem-model";
import { historicalRepresentativeFilesystemScenario } from "./scenarios/representative-filesystem";
import type { HizoFSV1FormatScenario } from "./scenarios/scenario-types";
import {
  applyScenario,
  observeObservableState,
  openFaultCampaignWritableScenarioSession,
  openFreshReadOnlySession,
} from "./support/hizofs-test-environment";
import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import {
  restoreFrozenPortableContainer,
  restoreFrozenPortableContainerIntoBackend,
  validateFrozenPortableContainerFixture,
} from "./support/portable-container";
import { createFeatureBits, type CredentialSlotId, type FileSystemId, type UnlockSequence } from "@/00-storage/service/hizofs/00-format";
import { cloneFileSystemRootKey, type FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { openEmptyEncryptedContainer } from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { PhysicalStoreFaultScheduleEntry } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { DynamicPhysicalStoreFaultCampaignInjector } from "./support/dynamic-physical-fault-campaign";
import { expect, it } from "vitest";

const SUPPORTED_FEATURE_BITS = createFeatureBits({ value: 0n });
const encoder = new TextEncoder();

type FaultCampaignCase = Readonly<{
  committedScenario: HizoFSV1FormatScenario;
  id: string;
  mutationScenario: HizoFSV1FormatScenario;
}>;

function faultCampaignCase({ id, operations }: {
  id: string;
  operations: HizoFSV1FormatScenario["operations"];
}): FaultCampaignCase {
  const mutationScenario: HizoFSV1FormatScenario = Object.freeze({
    id: `${id}-mutation`,
    operations: Object.freeze([...operations]),
  });
  return Object.freeze({
    committedScenario: Object.freeze({
      id: `${id}-committed`,
      operations: Object.freeze([
        ...historicalRepresentativeFilesystemScenario.operations,
        ...mutationScenario.operations,
      ]),
    }),
    id,
    mutationScenario,
  });
}

type BaselineAuthority = Readonly<{
  fileSystemId: FileSystemId;
  passphrase: string;
  rootKey: FileSystemRootKey;
  unlockingSlotId: CredentialSlotId;
  unlockSequence: UnlockSequence;
}>;

const faultCampaignCases: readonly FaultCampaignCase[] = Object.freeze([
  faultCampaignCase({
    id: "overwrite-file-v1",
    operations: Object.freeze([
      Object.freeze({ bytes: encoder.encode("mutated through the V1 writer\n"), path: Object.freeze(["hello.txt"]), type: "write_file" as const }),
    ]),
  }),
  faultCampaignCase({
    id: "create-file-v1",
    operations: Object.freeze([
      Object.freeze({ path: Object.freeze(["created-during-campaign.txt"]), type: "create_file" as const }),
    ]),
  }),
  faultCampaignCase({
    id: "move-entry-v1",
    operations: Object.freeze([
      Object.freeze({ from: Object.freeze(["docs", "nested.txt"]), replace: false, to: Object.freeze(["moved-nested.txt"]), type: "move_entry" as const }),
    ]),
  }),
  faultCampaignCase({
    id: "recursive-delete-v1",
    operations: Object.freeze([
      Object.freeze({ path: Object.freeze(["docs"]), recursive: true, type: "remove_entry" as const }),
    ]),
  }),
]);

async function createBaselineAuthority(): Promise<BaselineAuthority> {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const opened = await openEmptyEncryptedContainer({
    backend,
    passphrase: fixture.passphrase,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
  const rootKey = cloneFileSystemRootKey({ rootKey: opened.rootKey });
  const result: BaselineAuthority = {
    fileSystemId: opened.fileSystemId,
    passphrase: fixture.passphrase,
    rootKey,
    unlockingSlotId: opened.unlockingSlotId,
    unlockSequence: opened.unlockSequence,
  };
  opened.rootKey.destroy();
  return result;
}

async function openCampaignSession({ authority, faultInjector }: {
  authority: BaselineAuthority;
  faultInjector: DynamicPhysicalStoreFaultCampaignInjector;
}): Promise<Readonly<{
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  session: Awaited<ReturnType<typeof openFaultCampaignWritableScenarioSession>>;
}>> {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
  await restoreFrozenPortableContainerIntoBackend({ backend, fixture });
  const session = await openFaultCampaignWritableScenarioSession({
    backend,
    fileSystemId: authority.fileSystemId,
    rootKey: cloneFileSystemRootKey({ rootKey: authority.rootKey }),
    unlockingSlotId: authority.unlockingSlotId,
    unlockSequence: authority.unlockSequence,
  });
  return { backend, session };
}

async function discoverCurrentPersistenceFaultPoints({ authority, mutationScenario }: {
  authority: BaselineAuthority;
  mutationScenario: HizoFSV1FormatScenario;
}): Promise<readonly PhysicalStoreFaultScheduleEntry[]> {
  const faultInjector = new DynamicPhysicalStoreFaultCampaignInjector({ target: undefined });
  const opened = await openCampaignSession({ authority, faultInjector });
  faultInjector.enableRecording();
  try {
    await applyScenario({ scenario: mutationScenario, session: opened.session });
    await opened.session.sync();
  } finally {
    faultInjector.disable();
    await opened.session.close();
  }
  return faultInjector.persistenceFaultPoints();
}

async function exerciseFaultPoint({ authority, committedScenario, mutationScenario, target }: {
  authority: BaselineAuthority;
  committedScenario: HizoFSV1FormatScenario;
  mutationScenario: HizoFSV1FormatScenario;
  target: PhysicalStoreFaultScheduleEntry;
}): Promise<void> {
  const faultInjector = new DynamicPhysicalStoreFaultCampaignInjector({ target });
  const opened = await openCampaignSession({ authority, faultInjector });
  faultInjector.enableInjection();
  let acknowledged = false;
  try {
    await applyScenario({ scenario: mutationScenario, session: opened.session });
    await opened.session.sync();
    acknowledged = true;
  } catch {
    // A physical-store fault may be translated by a higher HizoFS layer.
    // `wasTriggered()` is the authority for whether this discovered point fired.
  } finally {
    faultInjector.disable();
  }

  expect(faultInjector.wasTriggered()).toBe(true);

  // Deliberately skip graceful close before the crash. Closing could add
  // persistence work that did not exist at the discovered fault point.
  await opened.backend.crashAndRecover();
  const fresh = await openFreshReadOnlySession({
    backend: opened.backend,
    expectedFileSystemId: authority.fileSystemId,
    passphrase: authority.passphrase,
  });
  try {
    const actual = await observeObservableState({ session: fresh });
    const before = expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario });
    const after = expectedObservableState({ scenario: committedScenario });
    if (acknowledged) {
      expect(actual).toEqual(after);
    } else {
      expect([before, after]).toContainEqual(actual);
    }
  } finally {
    await fresh.close();
    await opened.session.close().catch(() => undefined);
  }
}

for (const campaign of faultCampaignCases) {
  it(`sweeps every currently observed ${campaign.id} persistence fault point without freezing the physical I/O sequence`, async () => {
    const { committedScenario, id: _id, mutationScenario, ...unhandledCampaign } = campaign;
    unhandledCampaign satisfies Record<PropertyKey, never>;
    const authority = await createBaselineAuthority();
    try {
      const points = await discoverCurrentPersistenceFaultPoints({ authority, mutationScenario });
      expect(points.length).toBeGreaterThan(0);
      for (const target of points) {
        await exerciseFaultPoint({ authority, committedScenario, mutationScenario, target });
      }
    } finally {
      authority.rootKey.destroy();
    }
  }, 30_000);
}
