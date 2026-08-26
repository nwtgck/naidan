import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";
import credentialFixtureJson from "./fixtures/credential-lifecycle-v1.json";
import emptyFileFixtureJson from "./fixtures/empty-files-v1.json";
import emptyFixtureJson from "./fixtures/empty-filesystem-v1.json";
import largeFile600kFixtureJson from "./fixtures/large-file-600k-v1.json";
import maximumLexicalBoundaryFixtureJson from "./fixtures/maximum-lexical-boundaries-v1.json";
import multiChunkFixtureJson from "./fixtures/multi-chunk-file-v1.json";
import multipleCredentialsFixtureJson from "./fixtures/multiple-credentials-v1.json";
import mutationHistoryFixtureJson from "./fixtures/mutation-history-v1.json";
import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import sparseAndReflinkFixtureJson from "./fixtures/sparse-and-reflink-v1.json";
import symlinkFixtureJson from "./fixtures/symlink-v1.json";
import treeBackedFixtureJson from "./fixtures/tree-backed-directory-and-file-v1.json";
import unicodeFixtureJson from "./fixtures/unicode-filesystem-v1.json";
import unicodeNormalizationFixtureJson from "./fixtures/unicode-normalization-distinct-v1.json";
import historicalFixtureManifestJson from "./fixtures/manifest.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import { credentialReplacementObservableScenario } from "./scenarios/credential-lifecycle";
import {
  emptyFileScenario,
  emptyFilesystemScenario,
  historicalRepresentativeFilesystemScenario,
  largeFile600kScenario,
  maximumLexicalBoundaryScenario,
  multiChunkFileScenario,
  writerMutationScenario,
  sparseAndReflinkScenario,
  symlinkScenario,
  treeBackedFilesystemScenario,
  unicodeFilesystemScenario,
  unicodeNormalizationDistinctScenario,
} from "./scenarios/representative-filesystem";
import { openFreshReadOnlySession, observeObservableState } from "./support/hizofs-test-environment";
import {
  restoreFrozenPortableContainer,
  validateFrozenPortableContainerFixture
} from "./support/portable-container";
import { describe, expect, it } from "vitest";

const historicalReaderCases = Object.freeze([
  { fixtureFile: "credential-lifecycle-v1.json", fixtureJson: credentialFixtureJson, scenario: credentialReplacementObservableScenario },
  { fixtureFile: "empty-files-v1.json", fixtureJson: emptyFileFixtureJson, scenario: emptyFileScenario },
  { fixtureFile: "empty-filesystem-v1.json", fixtureJson: emptyFixtureJson, scenario: emptyFilesystemScenario },
  { fixtureFile: "large-file-600k-v1.json", fixtureJson: largeFile600kFixtureJson, scenario: largeFile600kScenario },
  { fixtureFile: "maximum-lexical-boundaries-v1.json", fixtureJson: maximumLexicalBoundaryFixtureJson, scenario: maximumLexicalBoundaryScenario },
  { fixtureFile: "multi-chunk-file-v1.json", fixtureJson: multiChunkFixtureJson, scenario: multiChunkFileScenario },
  { fixtureFile: "multiple-credentials-v1.json", fixtureJson: multipleCredentialsFixtureJson, scenario: emptyFilesystemScenario },
  { fixtureFile: "mutation-history-v1.json", fixtureJson: mutationHistoryFixtureJson, scenario: writerMutationScenario },
  { fixtureFile: "representative-filesystem-v1.json", fixtureJson: representativeFixtureJson, scenario: historicalRepresentativeFilesystemScenario },
  { fixtureFile: "sparse-and-reflink-v1.json", fixtureJson: sparseAndReflinkFixtureJson, scenario: sparseAndReflinkScenario },
  { fixtureFile: "symlink-v1.json", fixtureJson: symlinkFixtureJson, scenario: symlinkScenario },
  { fixtureFile: "tree-backed-directory-and-file-v1.json", fixtureJson: treeBackedFixtureJson, scenario: treeBackedFilesystemScenario },
  { fixtureFile: "unicode-filesystem-v1.json", fixtureJson: unicodeFixtureJson, scenario: unicodeFilesystemScenario },
  { fixtureFile: "unicode-normalization-distinct-v1.json", fixtureJson: unicodeNormalizationFixtureJson, scenario: unicodeNormalizationDistinctScenario },
] as const);

describe("HizoFS V1 historical reader compatibility", () => {
  it("requires every frozen historical fixture manifest entry to have an active reader compatibility case", () => {
    const manifestEntries = historicalFixtureManifestJson.fixtures.map(entry => {
      const { file, origin, scenarioId, sha256: _sha256, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      return { file, origin, scenarioId };
    });
    const readerEntries = historicalReaderCases.map(entry => {
      const { fixtureFile: file, fixtureJson: _fixtureJson, scenario, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      return { file, origin: "real_hizofs_writer" as const, scenarioId: scenario.id };
    });
    expect(readerEntries).toEqual(manifestEntries);
  });

  it("keeps the multi-chunk corpus scenario beyond one V1 File Data plaintext record", () => {
    const operation = multiChunkFileScenario.operations[0];
    if (operation === undefined || operation.type !== "write_file") throw new Error("multi-chunk scenario must start with one file write");
    expect(operation.bytes.byteLength).toBeGreaterThan(HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes);
  });

  for (const entry of historicalReaderCases) {
    const { fixtureFile: _fixtureFile, fixtureJson, scenario, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    it(`reopens frozen real V1 container ${scenario.id} and exposes exactly the declared filesystem state`, async () => {
      const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
      const backend = await restoreFrozenPortableContainer({ fixture });
      const session = await openFreshReadOnlySession({
        backend,
        expectedFileSystemId: fixture.fileSystemId,
        passphrase: fixture.passphrase,
      });
      try {
        expect(await observeObservableState({ session })).toEqual(expectedObservableState({ scenario }));
      } finally {
        await session.close();
      }
    });
  }
});


it("opens one frozen multi-Credential-Slot V1 container with either retained passphrase", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: multipleCredentialsFixtureJson });
  const alternatePassphrase = "multi-slot-secondary-passphrase";
  const backend = await restoreFrozenPortableContainer({ fixture });
  const session = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: alternatePassphrase,
  });
  try {
    expect(await observeObservableState({ session })).toEqual(expectedObservableState({ scenario: emptyFilesystemScenario }));
  } finally {
    await session.close();
  }
});

async function readRootFileRange({ fixtureJson, filename, start, end }: {
  fixtureJson: unknown;
  filename: string;
  start: number;
  end: number;
}): Promise<Uint8Array> {
  const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const session = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  });
  try {
    const file = await session.root.getFileHandle({ create: false, name: filename });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    try {
      return new Uint8Array(await new Response(readable.stream({ start, end, signal: undefined })).arrayBuffer());
    } finally {
      await readable.close();
    }
  } finally {
    await session.close();
  }
}

it("reads exact bytes across the frozen V1 File Data chunk boundary", async () => {
  const start = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes - 16;
  const end = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes + 16;
  const bytes = await readRootFileRange({
    end,
    filename: "multi-chunk.bin",
    fixtureJson: multiChunkFixtureJson,
    start,
  });
  expect([...bytes]).toEqual(Array.from({ length: end - start }, (_, index) => (start + index) % 251));
});

it("reads the sparse hole-to-data boundary exactly from the frozen V1 corpus", async () => {
  const bytes = await readRootFileRange({
    end: 65_539,
    filename: "sparse.bin",
    fixtureJson: sparseAndReflinkFixtureJson,
    start: 65_528,
  });
  expect([...bytes]).toEqual([...new Uint8Array(8), ...new TextEncoder().encode("tai")]);
});

it("resolves frozen historical V1 entries by direct generic lookup without changing their kinds", async () => {
  const representative = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const representativeBackend = await restoreFrozenPortableContainer({ fixture: representative });
  const representativeSession = await openFreshReadOnlySession({
    backend: representativeBackend,
    expectedFileSystemId: representative.fileSystemId,
    passphrase: representative.passphrase,
  });
  try {
    const file = await representativeSession.root.getEntryHandle({ name: "hello.txt" });
    const directory = await representativeSession.root.getEntryHandle({ name: "docs" });
    expect({ kind: file.kind, name: file.name }).toEqual({ kind: "file", name: "hello.txt" });
    expect({ kind: directory.kind, name: directory.name }).toEqual({ kind: "directory", name: "docs" });
    await expect(representativeSession.root.getEntryHandle({ name: "missing-entry" })).rejects.toThrow();
  } finally {
    await representativeSession.close();
  }

  const symlink = validateFrozenPortableContainerFixture({ fixture: symlinkFixtureJson });
  const symlinkBackend = await restoreFrozenPortableContainer({ fixture: symlink });
  const symlinkSession = await openFreshReadOnlySession({
    backend: symlinkBackend,
    expectedFileSystemId: symlink.fileSystemId,
    passphrase: symlink.passphrase,
  });
  try {
    const link = await symlinkSession.root.getEntryHandle({ name: "target-link" });
    expect({ kind: link.kind, name: link.name }).toEqual({ kind: "symlink", name: "target-link" });
  } finally {
    await symlinkSession.close();
  }
});

it("preserves exact persisted stat values from frozen historical V1 bytes", async () => {
  const representative = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const representativeBackend = await restoreFrozenPortableContainer({ fixture: representative });
  const representativeSession = await openFreshReadOnlySession({
    backend: representativeBackend,
    expectedFileSystemId: representative.fileSystemId,
    passphrase: representative.passphrase,
  });
  try {
    expect(await representativeSession.root.stat()).toEqual({ createdAt: undefined, modifiedAt: 1_700_000_000_003, size: 0 });
    expect(await (await representativeSession.root.getDirectoryHandle({ create: false, name: "docs" })).stat())
      .toEqual({ createdAt: 1_700_000_000_003, modifiedAt: 1_700_000_000_004, size: 0 });
    expect(await (await representativeSession.root.getFileHandle({ create: false, name: "hello.txt" })).stat())
      .toEqual({ createdAt: 1_700_000_000_000, modifiedAt: 1_700_000_000_002, size: 6 });
  } finally {
    await representativeSession.close();
  }

  const symlink = validateFrozenPortableContainerFixture({ fixture: symlinkFixtureJson });
  const symlinkBackend = await restoreFrozenPortableContainer({ fixture: symlink });
  const symlinkSession = await openFreshReadOnlySession({
    backend: symlinkBackend,
    expectedFileSystemId: symlink.fileSystemId,
    passphrase: symlink.passphrase,
  });
  try {
    expect(await (await symlinkSession.root.getEntryHandle({ name: "target-link" })).stat())
      .toEqual({ createdAt: 1_700_000_000_004, modifiedAt: 1_700_000_000_004, size: 15 });
    expect(await (await symlinkSession.root.getEntryHandle({ name: "dangling-link" })).stat())
      .toEqual({ createdAt: 1_700_000_000_005, modifiedAt: 1_700_000_000_005, size: 18 });
  } finally {
    await symlinkSession.close();
  }
});
