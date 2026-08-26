import { expectedObservableState } from "./model/reference-filesystem-model";
import { credentialReplacementObservableScenario } from "./scenarios/credential-lifecycle";
import {
  emptyFileScenario,
  directoryReplaceScenario,
  historicalContainerUpdateScenario,
  historicalCredentialContainerUpdateScenario,
  historicalMultiChunkUpdateScenario,
  historicalMutationHistoryUpdateScenario,
  historicalMultipleCredentialsUpdateScenario,
  historicalReflinkUpdateScenario,
  historicalRepresentativeFilesystemScenario,
  historicalTreeBackedUpdateScenario,
  historicalUnicodeNormalizationUpdateScenario,
  idempotentEnsureScenario,
  largeFile600kScenario,
  maximumLexicalBoundaryScenario,
  multiChunkFileScenario,
  nonDirectoryReplacementScenario,
  reflinkReplaceScenario,
  sparseAndReflinkScenario,
  symlinkScenario,
  treeBackedFilesystemScenario,
  truncateGrowthScenario,
  unicodeFilesystemScenario,
  unicodeNormalizationDistinctScenario,
  writerMutationScenario,
} from "./scenarios/representative-filesystem";
import {
  applyScenario,
  createWritableScenarioSession,
  observeObservableState,
  openFreshReadOnlySession,
  openFrozenFixtureWritableScenarioSession,
} from "./support/hizofs-test-environment";
import credentialFixtureJson from "./fixtures/credential-lifecycle-v1.json";
import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import sparseAndReflinkFixtureJson from "./fixtures/sparse-and-reflink-v1.json";
import multiChunkFixtureJson from "./fixtures/multi-chunk-file-v1.json";
import multipleCredentialsFixtureJson from "./fixtures/multiple-credentials-v1.json";
import mutationHistoryFixtureJson from "./fixtures/mutation-history-v1.json";
import treeBackedFixtureJson from "./fixtures/tree-backed-directory-and-file-v1.json";
import unicodeNormalizationFixtureJson from "./fixtures/unicode-normalization-distinct-v1.json";
import type { HizoFSV1FormatScenario } from "./scenarios/scenario-types";
import { describe, expect, it } from "vitest";

for (const scenario of [
  emptyFileScenario,
  directoryReplaceScenario,
  historicalRepresentativeFilesystemScenario,
  idempotentEnsureScenario,
  largeFile600kScenario,
  maximumLexicalBoundaryScenario,
  multiChunkFileScenario,
  nonDirectoryReplacementScenario,
  reflinkReplaceScenario,
  writerMutationScenario,
  sparseAndReflinkScenario,
  symlinkScenario,
  treeBackedFilesystemScenario,
  truncateGrowthScenario,
  unicodeFilesystemScenario,
  unicodeNormalizationDistinctScenario,
]) {
  describe(`HizoFS V1 writer compatibility: ${scenario.id}`, () => {
    it("persists the declared state so a fresh runtime observes exactly that state", async () => {
      const writable = await createWritableScenarioSession();
      try {
        await applyScenario({ scenario, session: writable.session });
        await writable.session.sync();
      } finally {
        await writable.session.close();
      }

      const fresh = await openFreshReadOnlySession({
        backend: writable.backend,
        expectedFileSystemId: undefined,
        passphrase: writable.passphrase,
      });
      try {
        expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario }));
      } finally {
        await fresh.close();
      }
    });
  });
}

const historicalWriterUpdateCases = Object.freeze([
  {
    caseId: "credential-replaced-historical-container",
    baseScenario: credentialReplacementObservableScenario,
    fixtureJson: credentialFixtureJson,
    mutationScenario: historicalCredentialContainerUpdateScenario,
  },
  {
    caseId: "representative-historical-container",
    baseScenario: historicalRepresentativeFilesystemScenario,
    fixtureJson: representativeFixtureJson,
    mutationScenario: historicalContainerUpdateScenario,
  },
  {
    caseId: "tree-backed-historical-container",
    baseScenario: treeBackedFilesystemScenario,
    fixtureJson: treeBackedFixtureJson,
    mutationScenario: historicalTreeBackedUpdateScenario,
  },
  {
    caseId: "multi-chunk-historical-container",
    baseScenario: multiChunkFileScenario,
    fixtureJson: multiChunkFixtureJson,
    mutationScenario: historicalMultiChunkUpdateScenario,
  },
  {
    caseId: "mutation-history-historical-container",
    baseScenario: writerMutationScenario,
    fixtureJson: mutationHistoryFixtureJson,
    mutationScenario: historicalMutationHistoryUpdateScenario,
  },
  {
    caseId: "reflink-historical-container",
    baseScenario: sparseAndReflinkScenario,
    fixtureJson: sparseAndReflinkFixtureJson,
    mutationScenario: historicalReflinkUpdateScenario,
  },
  {
    caseId: "unicode-normalization-historical-container",
    baseScenario: unicodeNormalizationDistinctScenario,
    fixtureJson: unicodeNormalizationFixtureJson,
    mutationScenario: historicalUnicodeNormalizationUpdateScenario,
  },
] as const);

for (const entry of historicalWriterUpdateCases) {
  const { baseScenario, caseId, fixtureJson, mutationScenario, ...unhandled } = entry;
  unhandled satisfies Record<PropertyKey, never>;
  it(`updates frozen historical V1 container ${caseId} without losing unrelated historical data`, async () => {
    const writable = await openFrozenFixtureWritableScenarioSession({ fixtureJson });
    try {
      await applyScenario({ scenario: mutationScenario, session: writable.session });
      await writable.session.sync();
    } finally {
      await writable.session.close();
    }

    const expectedScenario = Object.freeze({
      id: `${baseScenario.id}-after-current-writer-update-v1`,
      operations: Object.freeze([
        ...baseScenario.operations,
        ...mutationScenario.operations,
      ]),
    }) satisfies HizoFSV1FormatScenario;
    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: writable.fileSystemId,
      passphrase: writable.passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario: expectedScenario }));
    } finally {
      await fresh.close();
    }
  });
}

it("preserves every retained Credential Slot while current writer mutates a frozen multi-slot V1 container", async () => {
  const writable = await openFrozenFixtureWritableScenarioSession({ fixtureJson: multipleCredentialsFixtureJson });
  try {
    await applyScenario({ scenario: historicalMultipleCredentialsUpdateScenario, session: writable.session });
    await writable.session.sync();
  } finally {
    await writable.session.close();
  }

  for (const passphrase of [multipleCredentialsFixtureJson.passphrase, "multi-slot-secondary-passphrase"]) {
    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: writable.fileSystemId,
      passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: historicalMultipleCredentialsUpdateScenario }),
      );
    } finally {
      await fresh.close();
    }
  }
});

it("treats an identical-path move as a no-op without changing persisted V1 state", async () => {
  const writable = await createWritableScenarioSession();
  try {
    await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
    await writable.session.root.moveEntry({
      destination: writable.session.root,
      name: "hello.txt",
      newName: "hello.txt",
      replace: false,
    });
    await writable.session.sync();
  } finally {
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: undefined,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await fresh.close();
  }
});

it("aborts prepared file content changes without leaking them into persisted V1 state", async () => {
  const writable = await createWritableScenarioSession();
  try {
    await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
    const file = await writable.session.root.getFileHandle({ create: false, name: "hello.txt" });
    const prepared = await file.createWritable({ keepExistingData: true });
    await prepared.write({ data: new TextEncoder().encode("must-not-persist"), position: 0 });
    await prepared.truncate({ size: 1 });
    await prepared.abort({ reason: new Error("intentional test abort") });
    await writable.session.sync();
  } finally {
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: undefined,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await fresh.close();
  }
});

it("replaces existing file content when keepExistingData is false and commits an unwritten replacement as empty", async () => {
  const replacementBytes = new TextEncoder().encode("replacement");
  const expectedScenario: HizoFSV1FormatScenario = {
    id: "keep-existing-data-false-v1",
    operations: [
      ...historicalRepresentativeFilesystemScenario.operations,
      { bytes: replacementBytes, path: ["hello.txt"], type: "write_file" },
      { bytes: new Uint8Array(), path: ["docs", "nested.txt"], type: "write_file" },
    ],
  };
  const writable = await createWritableScenarioSession();
  try {
    await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });

    const hello = await writable.session.root.getFileHandle({ create: false, name: "hello.txt" });
    const replacement = await hello.createWritable({ keepExistingData: false });
    await replacement.write({ data: replacementBytes, position: 0 });
    await replacement.close();

    const docs = await writable.session.root.getDirectoryHandle({ create: false, name: "docs" });
    const nested = await docs.getFileHandle({ create: false, name: "nested.txt" });
    const emptyReplacement = await nested.createWritable({ keepExistingData: false });
    await emptyReplacement.close();

    await writable.session.sync();
  } finally {
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: undefined,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario: expectedScenario }));
  } finally {
    await fresh.close();
  }
});

it("allows only one active writer per file without leaking the rejected writer into persisted V1 state", async () => {
  const committedBytes = new TextEncoder().encode("committed-after-conflict");
  const expectedScenario: HizoFSV1FormatScenario = {
    id: "single-active-writer-v1",
    operations: [
      ...historicalRepresentativeFilesystemScenario.operations,
      { bytes: committedBytes, path: ["hello.txt"], type: "write_file" },
    ],
  };
  const writable = await createWritableScenarioSession();
  try {
    await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
    const file = await writable.session.root.getFileHandle({ create: false, name: "hello.txt" });
    const first = await file.createWritable({ keepExistingData: true });

    await expect(file.createWritable({ keepExistingData: false })).rejects.toThrow("active writer");
    await first.write({ data: new TextEncoder().encode("must-not-persist"), position: 0 });
    await first.abort({ reason: new Error("intentional writer conflict cleanup") });

    const second = await file.createWritable({ keepExistingData: false });
    await second.write({ data: committedBytes, position: 0 });
    await second.close();
    await writable.session.sync();
  } finally {
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: undefined,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario: expectedScenario }));
  } finally {
    await fresh.close();
  }
});

describe("HizoFS V1 writer conformance rejection", () => {
  it("rejects destructive namespace conflicts without damaging the previously persisted state", async () => {
    const writable = await createWritableScenarioSession();
    try {
      await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
      const docs = await writable.session.root.getDirectoryHandle({ create: false, name: "docs" });

      await expect(writable.session.root.removeEntry({
        name: "docs",
        recursive: false,
      })).rejects.toThrow();
      await expect(writable.session.root.moveEntry({
        destination: docs,
        name: "hello.txt",
        newName: "nested.txt",
        replace: false,
      })).rejects.toThrow();
      await expect(writable.session.root.cloneFile({
        destination: docs,
        name: "hello.txt",
        newName: "nested.txt",
        replace: false,
      })).rejects.toThrow();
      await expect(writable.session.root.moveEntry({
        destination: writable.session.root,
        name: "hello.txt",
        newName: "docs",
        replace: true,
      })).rejects.toThrow();
      await expect(writable.session.root.moveEntry({
        destination: writable.session.root,
        name: "docs",
        newName: "hello.txt",
        replace: true,
      })).rejects.toThrow();
      await expect(writable.session.root.cloneFile({
        destination: writable.session.root,
        name: "hello.txt",
        newName: "docs",
        replace: true,
      })).rejects.toThrow();
      await expect(writable.session.root.cloneFile({
        destination: writable.session.root,
        name: "hello.txt",
        newName: "hello.txt",
        replace: true,
      })).rejects.toThrow();
      await expect(writable.session.root.moveEntry({
        destination: docs,
        name: "docs",
        newName: "cycle",
        replace: false,
      })).rejects.toThrow();
      await expect(writable.session.root.getFileHandle({ create: true, name: "docs" })).rejects.toThrow();
      await expect(writable.session.root.getDirectoryHandle({ create: true, name: "hello.txt" })).rejects.toThrow();
      await expect(writable.session.root.createSymlink({ name: "hello.txt", target: "docs/nested.txt" })).rejects.toThrow();
      await writable.session.sync();
    } finally {
      await writable.session.close();
    }

    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: undefined,
      passphrase: writable.passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
      );
    } finally {
      await fresh.close();
    }
  });

  it("rejects replacing a non-empty directory and preserves both directory trees", async () => {
    const initialScenario = {
      id: "non-empty-directory-replacement-rejection-v1",
      operations: Object.freeze([
        { path: Object.freeze(["source-directory"]), type: "mkdir" as const },
        {
          bytes: new TextEncoder().encode("source survives\n"),
          path: Object.freeze(["source-directory", "source.txt"]),
          type: "write_file" as const,
        },
        { path: Object.freeze(["destination-directory"]), type: "mkdir" as const },
        {
          bytes: new TextEncoder().encode("destination survives\n"),
          path: Object.freeze(["destination-directory", "existing.txt"]),
          type: "write_file" as const,
        },
      ]),
    } satisfies HizoFSV1FormatScenario;
    const writable = await createWritableScenarioSession();
    try {
      await applyScenario({ scenario: initialScenario, session: writable.session });
      await expect(writable.session.root.moveEntry({
        destination: writable.session.root,
        name: "source-directory",
        newName: "destination-directory",
        replace: true,
      })).rejects.toThrow();
      await writable.session.sync();
    } finally {
      await writable.session.close();
    }

    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: writable.fileSystemId,
      passphrase: writable.passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(expectedObservableState({ scenario: initialScenario }));
    } finally {
      await fresh.close();
    }
  });

  it("rejects invalid V1 lexical forms without damaging the previously persisted state", async () => {
    const writable = await createWritableScenarioSession();
    try {
      await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
      for (const name of ["", ".", "..", "contains/slash", "contains\0nul", "\ud800"]) {
        await expect(writable.session.root.getFileHandle({ create: true, name })).rejects.toThrow();
      }
      await expect(writable.session.root.createSymlink({
        name: "empty-target",
        target: "",
      })).rejects.toThrow();
      await expect(writable.session.root.createSymlink({
        name: "nul-target",
        target: "contains\0nul",
      })).rejects.toThrow();
      await writable.session.sync();
    } finally {
      await writable.session.close();
    }

    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: undefined,
      passphrase: writable.passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
      );
    } finally {
      await fresh.close();
    }
  });

  it("rejects values beyond V1 lexical bounds without damaging the previously persisted state", async () => {
    const writable = await createWritableScenarioSession();
    try {
      await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
      await expect(writable.session.root.getFileHandle({
        create: true,
        name: "f".repeat(256),
      })).rejects.toThrow();
      await expect(writable.session.root.createSymlink({
        name: "too-long-target",
        target: "t".repeat(4_097),
      })).rejects.toThrow();
      await writable.session.sync();
    } finally {
      await writable.session.close();
    }

    const fresh = await openFreshReadOnlySession({
      backend: writable.backend,
      expectedFileSystemId: undefined,
      passphrase: writable.passphrase,
    });
    try {
      expect(await observeObservableState({ session: fresh })).toEqual(
        expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
      );
    } finally {
      await fresh.close();
    }
  });
});
