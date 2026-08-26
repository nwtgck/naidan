import credentialFixtureJson from "./fixtures/credential-lifecycle-v1.json";
import emptyFixtureJson from "./fixtures/empty-filesystem-v1.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import {
  afterCredentialReplacementScenario,
  beforeCredentialReplacementScenario,
  credentialReplacementObservableScenario,
} from "./scenarios/credential-lifecycle";
import {
  applyScenario,
  createCredentialWritableScenarioSession,
  observeObservableState,
  openFreshReadOnlySession,
  openFrozenFixtureCredentialWritableScenarioSession,
  replaceCredentialWritableScenarioPassphrase,
} from "./support/hizofs-test-environment";
import { DynamicPhysicalStoreFaultCampaignInjector } from "./support/dynamic-physical-fault-campaign";
import type { PhysicalStoreFaultScheduleEntry } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { restoreFrozenPortableContainer, validateFrozenPortableContainerFixture } from "./support/portable-container";
import { expect, it } from "vitest";

it("replaces the container credential without changing persisted filesystem meaning", async () => {
  const oldPassphrase = "old-passphrase";
  const newPassphrase = "new-passphrase";
  const writable = await createCredentialWritableScenarioSession({ passphrase: oldPassphrase });
  try {
    await applyScenario({ scenario: beforeCredentialReplacementScenario, session: writable.session });
    await replaceCredentialWritableScenarioPassphrase({
      replacementPassphrase: newPassphrase,
      session: writable.session,
    });
    await applyScenario({ scenario: afterCredentialReplacementScenario, session: writable.session });
    await writable.flushAndCaptureCleanGeneration();
  } finally {
    await writable.releaseResources();
    await writable.session.close();
  }

  await expect(openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: oldPassphrase,
  })).rejects.toMatchObject({ code: "credential_rejected" });

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: newPassphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: credentialReplacementObservableScenario }),
    );
  } finally {
    await fresh.close();
  }
});


it("rejects an invalid replacement passphrase without changing the existing credential authority or filesystem state", async () => {
  const oldPassphrase = "retained-old-passphrase";
  const invalidReplacement = `${"é".repeat(512)}a`;
  const writable = await createCredentialWritableScenarioSession({ passphrase: oldPassphrase });
  try {
    await applyScenario({ scenario: beforeCredentialReplacementScenario, session: writable.session });
    await writable.flushAndCaptureCleanGeneration();
    await expect(replaceCredentialWritableScenarioPassphrase({
      replacementPassphrase: invalidReplacement,
      session: writable.session,
    })).rejects.toThrow("passphrase");
  } finally {
    await writable.releaseResources();
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: oldPassphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: beforeCredentialReplacementScenario }),
    );
  } finally {
    await fresh.close();
  }
});

it("keeps an acknowledged credential replacement durable across an immediate crash and fresh reopen", async () => {
  const oldPassphrase = "old-passphrase-before-crash";
  const newPassphrase = "new-passphrase-after-crash";
  const writable = await createCredentialWritableScenarioSession({ passphrase: oldPassphrase });
  try {
    await replaceCredentialWritableScenarioPassphrase({
      replacementPassphrase: newPassphrase,
      session: writable.session,
    });

    // Do not gracefully close before the simulated crash. The credential-update
    // operation has already acknowledged publication, so a fresh reader must
    // observe the new authority after recovery. This asserts the semantic
    // durability boundary, not the physical write sequence used to reach it.
    await writable.backend.crashAndRecover();

    await expect(openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: writable.fileSystemId,
      passphrase: oldPassphrase,
    })).rejects.toMatchObject({ code: "credential_rejected" });

    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: writable.fileSystemId,
      passphrase: newPassphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: { id: "credential-replacement-crash-v1", operations: Object.freeze([]) } }),
      );
    } finally {
      await fresh.close();
    }
  } finally {
    await writable.releaseResources();
    await writable.session.close().catch(() => undefined);
  }
});

it("keeps the replaced passphrase rejected by the frozen historical credential fixture", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: credentialFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: "old-passphrase",
  })).rejects.toMatchObject({ code: "credential_rejected" });
});

it("accepts the exact V1 passphrase UTF-8 byte limit and reopens with the same credential", async () => {
  const passphrase = "é".repeat(512);
  expect(new TextEncoder().encode(passphrase)).toHaveLength(1_024);
  const writable = await createCredentialWritableScenarioSession({ passphrase });
  try {
    await writable.flushAndCaptureCleanGeneration();
  } finally {
    await writable.releaseResources();
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: { id: "empty-at-passphrase-byte-limit-v1", operations: Object.freeze([]) } }),
    );
  } finally {
    await fresh.close();
  }
});

it("rejects passphrases outside the V1 lexical profile before creating a usable credential", async () => {
  const tooLongPassphrase = `${"é".repeat(512)}a`;
  expect(new TextEncoder().encode(tooLongPassphrase)).toHaveLength(1_025);

  await expect(createCredentialWritableScenarioSession({ passphrase: "" })).rejects.toThrow("passphrase");
  await expect(createCredentialWritableScenarioSession({ passphrase: tooLongPassphrase })).rejects.toThrow("passphrase");
  for (const separator of ["\r", "\n", "\u0085", "\u2028", "\u2029"]) {
    await expect(createCredentialWritableScenarioSession({
      passphrase: `before${separator}after`,
    })).rejects.toThrow("line separator");
  }
});

async function credentialOpensEmptyFixtureAfterRecovery({ backend, fileSystemId, passphrase }: {
  backend: Awaited<ReturnType<typeof openFrozenFixtureCredentialWritableScenarioSession>>["backend"];
  fileSystemId: string;
  passphrase: string;
}): Promise<boolean> {
  try {
    const fresh = await openFreshReadOnlySession({ backend, expectedFileSystemId: fileSystemId, passphrase });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: { id: "credential-fault-campaign-empty-v1", operations: Object.freeze([]) } }),
      );
    } finally {
      await fresh.close();
    }
    return true;
  } catch (cause: unknown) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "credential_rejected") return false;
    throw cause;
  }
}

async function discoverCredentialReplacementFaultPoints(): Promise<readonly PhysicalStoreFaultScheduleEntry[]> {
  const injector = new DynamicPhysicalStoreFaultCampaignInjector({ target: undefined });
  const writable = await openFrozenFixtureCredentialWritableScenarioSession({
    faultInjector: injector,
    fixtureJson: emptyFixtureJson,
  });
  injector.enableRecording();
  try {
    await replaceCredentialWritableScenarioPassphrase({
      replacementPassphrase: "fault-campaign-new-passphrase",
      session: writable.session,
    });
  } finally {
    injector.disable();
    await writable.releaseResources();
    await writable.session.close().catch(() => undefined);
  }
  return injector.persistenceFaultPoints();
}

async function exerciseCredentialReplacementFaultPoint({ target }: {
  target: PhysicalStoreFaultScheduleEntry;
}): Promise<void> {
  const injector = new DynamicPhysicalStoreFaultCampaignInjector({ target });
  const writable = await openFrozenFixtureCredentialWritableScenarioSession({
    faultInjector: injector,
    fixtureJson: emptyFixtureJson,
  });
  const oldPassphrase = writable.passphrase;
  const newPassphrase = "fault-campaign-new-passphrase";
  injector.enableInjection();
  let acknowledged = false;
  try {
    await replaceCredentialWritableScenarioPassphrase({
      replacementPassphrase: newPassphrase,
      session: writable.session,
    });
    acknowledged = true;
  } catch {
    // The physical-store fault can be translated by credential publication.
    // `wasTriggered()` proves that this discovered persistence point fired.
  } finally {
    injector.disable();
  }

  expect(injector.wasTriggered()).toBe(true);
  await writable.backend.crashAndRecover();
  const oldAccepted = await credentialOpensEmptyFixtureAfterRecovery({
    backend: writable.backend,
    fileSystemId: writable.fileSystemId,
    passphrase: oldPassphrase,
  });
  const newAccepted = await credentialOpensEmptyFixtureAfterRecovery({
    backend: writable.backend,
    fileSystemId: writable.fileSystemId,
    passphrase: newPassphrase,
  });

  if (acknowledged) {
    expect({ newAccepted, oldAccepted }).toEqual({ newAccepted: true, oldAccepted: false });
  } else {
    expect([oldAccepted, newAccepted]).toEqual(expect.arrayContaining([false, true]));
  }

  await writable.releaseResources();
  await writable.session.close().catch(() => undefined);
}

it("sweeps every currently observed credential-replacement durability transition without freezing physical I/O order", async () => {
  const discovered = await discoverCredentialReplacementFaultPoints();
  const durabilityTransitions = discovered.filter(({ occurrence: _occurrence, operation, timing: _timing, ...unhandled }) => {
    unhandled satisfies Record<PropertyKey, never>;
    return operation === "syncFileData";
  });
  expect(durabilityTransitions.length).toBeGreaterThan(0);
  for (const target of durabilityTransitions) await exerciseCredentialReplacementFaultPoint({ target });
}, 30_000);
