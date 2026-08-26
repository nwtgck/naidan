import { createFeatureBits } from "@/00-storage/service/hizofs/00-format";
import allSegmentsCorruptFixtureJson from "./negative-fixtures/all-segments-corrupt-v1.json";
import allSegmentsMissingFixtureJson from "./negative-fixtures/all-segments-missing-v1.json";
import bothSuperblocksCorruptFixtureJson from "./negative-fixtures/both-superblocks-corrupt-v1.json";
import bothSuperblocksTruncatedFixtureJson from "./negative-fixtures/both-superblocks-truncated-v1.json";
import bothSuperblocksMissingFixtureJson from "./negative-fixtures/both-superblocks-missing-v1.json";
import bothUnlockEnvelopesCorruptFixtureJson from "./negative-fixtures/both-unlock-envelopes-corrupt-v1.json";
import bothUnlockEnvelopesMissingFixtureJson from "./negative-fixtures/both-unlock-envelopes-missing-v1.json";
import unsupportedRequiredFeatureAuthenticatedFixtureJson from "./negative-fixtures/unsupported-required-feature-authenticated-v1.json";
import swappedSegmentPathBindingFixtureJson from "./negative-fixtures/swapped-segment-path-binding-v1.json";
import negativeFixtureManifestJson from "./negative-fixtures/manifest.json";
import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import { emptyFilesystemScenario } from "./scenarios/representative-filesystem";
import {
  observeObservableState,
  openFreshReadOnlySession,
  openFreshReadOnlySessionWithFeatureBits,
} from "./support/hizofs-test-environment";
import {
  restoreFrozenPortableContainer,
  validateFrozenPortableContainerFixture,
} from "./support/portable-container";
import { expect, it } from "vitest";

const negativeFixtureReaderCases = Object.freeze([
  {
    caseId: "both-superblocks-corrupt-v1",
    fixtureFile: "both-superblocks-corrupt-v1.json",
    fixtureJson: bothSuperblocksCorruptFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "both-superblocks-truncated-v1",
    fixtureFile: "both-superblocks-truncated-v1.json",
    fixtureJson: bothSuperblocksTruncatedFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "both-superblocks-missing-v1",
    fixtureFile: "both-superblocks-missing-v1.json",
    fixtureJson: bothSuperblocksMissingFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "both-unlock-envelopes-corrupt-v1",
    fixtureFile: "both-unlock-envelopes-corrupt-v1.json",
    fixtureJson: bothUnlockEnvelopesCorruptFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "both-unlock-envelopes-missing-v1",
    fixtureFile: "both-unlock-envelopes-missing-v1.json",
    fixtureJson: bothUnlockEnvelopesMissingFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "all-segments-corrupt-v1",
    fixtureFile: "all-segments-corrupt-v1.json",
    fixtureJson: allSegmentsCorruptFixtureJson,
    outcome: "reject_open_or_observation",
  },
  {
    caseId: "all-segments-missing-v1",
    fixtureFile: "all-segments-missing-v1.json",
    fixtureJson: allSegmentsMissingFixtureJson,
    outcome: "reject_open",
  },
  {
    caseId: "swapped-segment-path-binding-v1",
    fixtureFile: "swapped-segment-path-binding-v1.json",
    fixtureJson: swappedSegmentPathBindingFixtureJson,
    outcome: "reject_open_or_observation",
  },
  {
    caseId: "unsupported-required-feature-authenticated-v1",
    fixtureFile: "unsupported-required-feature-authenticated-v1.json",
    fixtureJson: unsupportedRequiredFeatureAuthenticatedFixtureJson,
    outcome: "unsupported_required_feature",
  },
] as const);

it("requires every negative-fixture manifest entry to have an active reader rejection case", () => {
  const manifestEntries = negativeFixtureManifestJson.fixtures.map(entry => {
    const { caseId, expectedOutcome: outcome, file, ...metadata } = entry;
    const metadataKeys = Object.keys(metadata);
    expect(metadataKeys.length).toBeGreaterThan(0);
    return { caseId, file, outcome };
  });
  const readerEntries = negativeFixtureReaderCases.map(entry => {
    const { caseId, fixtureFile: file, fixtureJson: _fixtureJson, outcome, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    return { caseId, file, outcome };
  });
  expect(readerEntries).toEqual(manifestEntries);
});

for (const entry of negativeFixtureReaderCases) {
  const { caseId, fixtureFile: _fixtureFile, fixtureJson, outcome, ...unhandled } = entry;
  unhandled satisfies Record<PropertyKey, never>;
  it(`enforces ${outcome} for frozen negative V1 corpus case ${caseId}`, async () => {
    const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
    switch (outcome) {
    case "reject_open": {
      const backend = await restoreFrozenPortableContainer({ fixture });
      await expect(openFreshReadOnlySession({
        backend,
        expectedFileSystemId: fixture.fileSystemId,
        passphrase: fixture.passphrase,
      })).rejects.toThrow();
      return;
    }
    case "reject_open_or_observation": {
      const backend = await restoreFrozenPortableContainer({ fixture });
      let session;
      try {
        session = await openFreshReadOnlySession({
          backend,
          expectedFileSystemId: fixture.fileSystemId,
          passphrase: fixture.passphrase,
        });
      } catch {
        return;
      }
      try {
        await expect(observeObservableState({ session })).rejects.toThrow();
      } finally {
        await session.close();
      }
      return;
    }
    case "unsupported_required_feature": {
      const supportedBackend = await restoreFrozenPortableContainer({ fixture });
      const supportedSession = await openFreshReadOnlySessionWithFeatureBits({
        backend: supportedBackend,
        expectedFileSystemId: fixture.fileSystemId,
        passphrase: fixture.passphrase,
        supportedFeatureBits: createFeatureBits({ value: 1n }),
      });
      try {
        expect(await observeObservableState({ session: supportedSession })).toEqual(expectedObservableState({
          scenario: emptyFilesystemScenario,
        }));
      } finally {
        await supportedSession.close();
      }

      const unsupportedBackend = await restoreFrozenPortableContainer({ fixture });
      await expect(openFreshReadOnlySession({
        backend: unsupportedBackend,
        expectedFileSystemId: fixture.fileSystemId,
        passphrase: fixture.passphrase,
      })).rejects.toMatchObject({ code: "unsupported_required_feature" });
      return;
    }
    default:
      outcome satisfies never;
    }
  });
}

it("rejects the historical V1 container when the passphrase does not authenticate a Credential Slot", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  await expect(openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: "definitely-not-the-fixture-passphrase",
  })).rejects.toMatchObject({ code: "credential_rejected" });
});
