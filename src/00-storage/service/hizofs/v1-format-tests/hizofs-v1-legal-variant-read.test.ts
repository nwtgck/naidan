import activeCommitCorruptFallbackFixtureJson from "./legal-variant-fixtures/active-commit-corrupt-fallback-v1.json";
import activeCommitSegmentMissingFallbackFixtureJson from "./legal-variant-fixtures/active-commit-segment-missing-fallback-v1.json";
import newestSuperblockCorruptFixtureJson from "./legal-variant-fixtures/newest-superblock-corrupt-v1.json";
import newestSuperblockMissingFixtureJson from "./legal-variant-fixtures/newest-superblock-missing-v1.json";
import singleSuperblockCorruptFixtureJson from "./legal-variant-fixtures/single-superblock-corrupt-v1.json";
import singleSuperblockMissingFixtureJson from "./legal-variant-fixtures/single-superblock-missing-v1.json";
import singleUnlockEnvelopeCorruptFixtureJson from "./legal-variant-fixtures/single-unlock-envelope-corrupt-v1.json";
import singleUnlockEnvelopeMissingFixtureJson from "./legal-variant-fixtures/single-unlock-envelope-missing-v1.json";
import legalVariantFixtureManifestJson from "./legal-variant-fixtures/manifest.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import { historicalRepresentativeFilesystemScenario } from "./scenarios/representative-filesystem";
import { openFreshReadOnlySession, observeObservableState } from "./support/hizofs-test-environment";
import { restoreFrozenPortableContainer, validateFrozenPortableContainerFixture } from "./support/portable-container";
import { describe, expect, it } from "vitest";

const legalVariantReaderCases = Object.freeze([
  { caseId: "single-superblock-corrupt-v1", fixtureFile: "single-superblock-corrupt-v1.json", fixtureJson: singleSuperblockCorruptFixtureJson },
  { caseId: "single-superblock-missing-v1", fixtureFile: "single-superblock-missing-v1.json", fixtureJson: singleSuperblockMissingFixtureJson },
  { caseId: "newest-superblock-corrupt-v1", fixtureFile: "newest-superblock-corrupt-v1.json", fixtureJson: newestSuperblockCorruptFixtureJson },
  { caseId: "newest-superblock-missing-v1", fixtureFile: "newest-superblock-missing-v1.json", fixtureJson: newestSuperblockMissingFixtureJson },
  { caseId: "single-unlock-envelope-corrupt-v1", fixtureFile: "single-unlock-envelope-corrupt-v1.json", fixtureJson: singleUnlockEnvelopeCorruptFixtureJson },
  { caseId: "single-unlock-envelope-missing-v1", fixtureFile: "single-unlock-envelope-missing-v1.json", fixtureJson: singleUnlockEnvelopeMissingFixtureJson },
  { caseId: "active-commit-corrupt-fallback-v1", fixtureFile: "active-commit-corrupt-fallback-v1.json", fixtureJson: activeCommitCorruptFallbackFixtureJson },
  { caseId: "active-commit-segment-missing-fallback-v1", fixtureFile: "active-commit-segment-missing-fallback-v1.json", fixtureJson: activeCommitSegmentMissingFallbackFixtureJson },
] as const);

describe("HizoFS V1 frozen legal-variant reader compatibility", () => {
  it("requires every legal-variant manifest entry to have an active reader compatibility case", () => {
    const manifestEntries = legalVariantFixtureManifestJson.fixtures.map(entry => {
      const { caseId, file, ...metadata } = entry;
      const metadataKeys = Object.keys(metadata);
      expect(metadataKeys.length).toBeGreaterThan(0);
      return { caseId, file };
    });
    const readerEntries = legalVariantReaderCases.map(entry => {
      const { caseId, fixtureFile: file, fixtureJson: _fixtureJson, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      return { caseId, file };
    });
    expect(readerEntries).toEqual(manifestEntries);
  });

  for (const entry of legalVariantReaderCases) {
    const { caseId, fixtureFile: _fixtureFile, fixtureJson, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    it(`reopens ${caseId} and exposes the complete V1-defined fallback state`, async () => {
      const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
      const backend = await restoreFrozenPortableContainer({ fixture });
      const session = await openFreshReadOnlySession({
        backend,
        expectedFileSystemId: fixture.fileSystemId,
        passphrase: fixture.passphrase,
      });
      try {
        expect(await observeObservableState({ session })).toEqual(expectedObservableState({
          scenario: historicalRepresentativeFilesystemScenario,
        }));
      } finally {
        await session.close();
      }
    });
  }
});
