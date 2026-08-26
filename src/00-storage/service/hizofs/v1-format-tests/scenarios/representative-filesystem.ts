import type { HizoFSV1FormatScenario } from "./scenario-types";

const text = ({ value }: { value: string }): Uint8Array => new TextEncoder().encode(value);

export const emptyFilesystemScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "empty-filesystem-historical-v1",
  operations: Object.freeze([]),
});

export const emptyFileScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "empty-files-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["empty.bin"]), type: "create_file" as const }),
    Object.freeze({ bytes: text({ value: "truncate me" }), path: Object.freeze(["truncate-to-zero.bin"]), type: "write_file" as const }),
    Object.freeze({ path: Object.freeze(["truncate-to-zero.bin"]), size: 0, type: "truncate_file" as const }),
  ]),
});

export const historicalRepresentativeFilesystemScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "representative-filesystem-historical-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["hello.txt"]), type: "write_file" as const, bytes: text({ value: "hello\n" }) }),
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["docs", "nested.txt"]), type: "write_file" as const, bytes: text({ value: "nested\n" }) }),
  ]),
});

export const historicalContainerUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-container-update-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["hello.txt"]), type: "write_file" as const, bytes: text({ value: "hello from current writer\n" }) }),
    Object.freeze({ path: Object.freeze(["docs", "added-by-current-writer.txt"]), type: "write_file" as const, bytes: text({ value: "added after historical reopen\n" }) }),
    Object.freeze({ from: Object.freeze(["docs", "nested.txt"]), replace: false, to: Object.freeze(["moved-from-historical.txt"]), type: "move_entry" as const }),
  ]),
});

export const historicalMutationHistoryUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-mutation-history-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "BETA" }),
      offset: 0,
      path: Object.freeze(["beta.txt"]),
      type: "write_file_at" as const,
    }),
    Object.freeze({
      bytes: text({ value: "added below a historically moved directory\n" }),
      path: Object.freeze(["moved-parent", "renamed-directory", "nested", "added-by-current-writer.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({
      from: Object.freeze(["replace-destination.txt"]),
      replace: false,
      to: Object.freeze(["docs", "moved-replacement.txt"]),
      type: "move_entry" as const,
    }),
  ]),
});

export const historicalTreeBackedUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-tree-backed-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "added to an existing tree-backed directory\n" }),
      path: Object.freeze(["tree-directory", "added-by-current-writer.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({
      bytes: Uint8Array.from({ length: 32 }, (_, index) => 250 - index),
      offset: 4_080,
      path: Object.freeze(["large-file.bin"]),
      type: "write_file_at" as const,
    }),
  ]),
});

export const historicalMultiChunkUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-multi-chunk-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: Uint8Array.from({ length: 32 }, (_, index) => 200 + (index % 31)),
      offset: 1_048_576 - 16,
      path: Object.freeze(["multi-chunk.bin"]),
      type: "write_file_at" as const,
    }),
    Object.freeze({ path: Object.freeze(["multi-chunk.bin"]), size: 1_100_128, type: "truncate_file" as const }),
  ]),
});

export const historicalReflinkUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-reflink-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: Uint8Array.of(201, 202, 203, 204),
      offset: 128,
      path: Object.freeze(["reflink-source.bin"]),
      type: "write_file_at" as const,
    }),
    Object.freeze({
      bytes: Uint8Array.of(101, 102, 103, 104),
      offset: 128,
      path: Object.freeze(["clones", "clone.bin"]),
      type: "write_file_at" as const,
    }),
    Object.freeze({ path: Object.freeze(["clones", "clone.bin"]), size: 4_000, type: "truncate_file" as const }),
  ]),
});

export const historicalMultipleCredentialsUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-multiple-credentials-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "written while multiple credential slots remain active\n" }),
      path: Object.freeze(["written-with-multiple-credentials.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const historicalCredentialContainerUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-credential-container-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "written after historical credential replacement\n" }),
      path: Object.freeze(["after-credential-replacement.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const idempotentEnsureScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "idempotent-ensure-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
    Object.freeze({ bytes: text({ value: "must survive repeated ensure\n" }), path: Object.freeze(["docs", "stable.txt"]), type: "write_file" as const }),
    Object.freeze({ path: Object.freeze(["docs", "stable.txt"]), type: "create_file" as const }),
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
  ]),
});

export const writerMutationScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "representative-writer-mutations-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["alpha.txt"]), type: "write_file" as const, bytes: text({ value: "alpha\n" }) }),
    Object.freeze({ path: Object.freeze(["docs", "stable.txt"]), type: "write_file" as const, bytes: text({ value: "stable\n" }) }),
    Object.freeze({ from: Object.freeze(["alpha.txt"]), replace: false, to: Object.freeze(["beta.txt"]), type: "move_entry" as const }),
    Object.freeze({ path: Object.freeze(["docs", "stable.txt"]), type: "write_file" as const, bytes: text({ value: "updated\n" }) }),
    Object.freeze({ path: Object.freeze(["move-source"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["move-source", "nested"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["move-source", "nested", "keep.txt"]), type: "write_file" as const, bytes: text({ value: "survives-directory-move\n" }) }),
    Object.freeze({ path: Object.freeze(["moved-parent"]), type: "mkdir" as const }),
    Object.freeze({ from: Object.freeze(["move-source"]), replace: false, to: Object.freeze(["moved-parent", "renamed-directory"]), type: "move_entry" as const }),
    Object.freeze({ path: Object.freeze(["replace-source.txt"]), type: "write_file" as const, bytes: text({ value: "replacement-source\n" }) }),
    Object.freeze({ path: Object.freeze(["replace-destination.txt"]), type: "write_file" as const, bytes: text({ value: "replacement-destination\n" }) }),
    Object.freeze({ from: Object.freeze(["replace-source.txt"]), replace: true, to: Object.freeze(["replace-destination.txt"]), type: "move_entry" as const }),
    Object.freeze({ path: Object.freeze(["empty-nonrecursive-delete"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["empty-nonrecursive-delete"]), recursive: false, type: "remove_entry" as const }),
    Object.freeze({ path: Object.freeze(["trash"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["trash", "delete-me.txt"]), type: "write_file" as const, bytes: text({ value: "temporary\n" }) }),
    Object.freeze({ path: Object.freeze(["trash"]), recursive: true, type: "remove_entry" as const }),
  ]),
});

export const directoryReplaceScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "directory-replace-empty-directory-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["source-directory"]), type: "mkdir" as const }),
    Object.freeze({
      bytes: text({ value: "survives directory replacement\n" }),
      path: Object.freeze(["source-directory", "kept.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({ path: Object.freeze(["destination-directory"]), type: "mkdir" as const }),
    Object.freeze({
      from: Object.freeze(["source-directory"]),
      replace: true,
      to: Object.freeze(["destination-directory"]),
      type: "move_entry" as const,
    }),
  ]),
});

export const nonDirectoryReplacementScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "file-symlink-replacement-matrix-v1",
  operations: Object.freeze([
    Object.freeze({ bytes: text({ value: "file replaces symlink\n" }), path: Object.freeze(["source-file.txt"]), type: "write_file" as const }),
    Object.freeze({ path: Object.freeze(["destination-symlink"]), target: "old-target", type: "create_symlink" as const }),
    Object.freeze({
      from: Object.freeze(["source-file.txt"]),
      replace: true,
      to: Object.freeze(["destination-symlink"]),
      type: "move_entry" as const,
    }),
    Object.freeze({ path: Object.freeze(["source-symlink"]), target: "kept-target", type: "create_symlink" as const }),
    Object.freeze({ bytes: text({ value: "file replaced by symlink\n" }), path: Object.freeze(["destination-file.txt"]), type: "write_file" as const }),
    Object.freeze({
      from: Object.freeze(["source-symlink"]),
      replace: true,
      to: Object.freeze(["destination-file.txt"]),
      type: "move_entry" as const,
    }),
  ]),
});

export const reflinkReplaceScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "reflink-replace-v1",
  operations: Object.freeze([
    Object.freeze({ bytes: text({ value: "source before reflink\n" }), path: Object.freeze(["source.txt"]), type: "write_file" as const }),
    Object.freeze({ bytes: text({ value: "destination to replace\n" }), path: Object.freeze(["destination.txt"]), type: "write_file" as const }),
    Object.freeze({ from: Object.freeze(["source.txt"]), replace: true, to: Object.freeze(["destination.txt"]), type: "clone_file" as const }),
    Object.freeze({ bytes: text({ value: "changed" }), offset: 0, path: Object.freeze(["source.txt"]), type: "write_file_at" as const }),
  ]),
});

export const truncateGrowthScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "truncate-growth-zero-fill-v1",
  operations: Object.freeze([
    Object.freeze({ bytes: text({ value: "prefix" }), path: Object.freeze(["grown.bin"]), type: "write_file" as const }),
    Object.freeze({ path: Object.freeze(["grown.bin"]), size: 8_192, type: "truncate_file" as const }),
  ]),
});

export const sparseAndReflinkScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "sparse-and-reflink-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["sparse.bin"]), type: "write_file" as const, bytes: text({ value: "prefix" }) }),
    Object.freeze({ path: Object.freeze(["sparse.bin"]), offset: 65_536, type: "write_file_at" as const, bytes: text({ value: "tail" }) }),
    Object.freeze({ path: Object.freeze(["sparse.bin"]), size: 65_539, type: "truncate_file" as const }),
    Object.freeze({ path: Object.freeze(["reflink-source.bin"]), type: "write_file" as const, bytes: Uint8Array.from({ length: 4_096 }, (_, index) => index % 251) }),
    Object.freeze({ path: Object.freeze(["clones"]), type: "mkdir" as const }),
    Object.freeze({ from: Object.freeze(["reflink-source.bin"]), replace: false, to: Object.freeze(["clones", "clone.bin"]), type: "clone_file" as const }),
    Object.freeze({ path: Object.freeze(["reflink-source.bin"]), offset: 2, type: "write_file_at" as const, bytes: Uint8Array.of(9, 8, 7, 6) }),
    Object.freeze({ path: Object.freeze(["clones", "clone.bin"]), offset: 8, type: "write_file_at" as const, bytes: Uint8Array.of(5, 4, 3, 2) }),
  ]),
});

export const symlinkScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "symlink-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["docs"]), type: "mkdir" as const }),
    Object.freeze({ path: Object.freeze(["docs", "target.txt"]), type: "write_file" as const, bytes: text({ value: "target\n" }) }),
    Object.freeze({ path: Object.freeze(["target-link"]), target: "docs/target.txt", type: "create_symlink" as const }),
    Object.freeze({ path: Object.freeze(["dangling-link"]), target: "missing/target.txt", type: "create_symlink" as const }),
  ]),
});

export const unicodeFilesystemScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "unicode-filesystem-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["日本語"]), type: "mkdir" as const }),
    Object.freeze({
      bytes: text({ value: "こんにちは🌏\n" }),
      path: Object.freeze(["日本語", "café-雪.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({
      path: Object.freeze(["リンク🌏"]),
      target: "日本語/café-雪.txt",
      type: "create_symlink" as const,
    }),
  ]),
});

export const unicodeNormalizationDistinctScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "unicode-normalization-distinct-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "NFC filename\n" }),
      path: Object.freeze(["é.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({
      bytes: text({ value: "NFD filename\n" }),
      path: Object.freeze(["e\u0301.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const historicalUnicodeNormalizationUpdateScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "historical-unicode-normalization-update-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "NFC filename updated by current writer\n" }),
      path: Object.freeze(["é.txt"]),
      type: "write_file" as const,
    }),
    Object.freeze({
      bytes: text({ value: "unrelated current-writer addition\n" }),
      path: Object.freeze(["plain.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const maximumLexicalBoundaryScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "maximum-lexical-boundaries-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "maximum filename boundary\n" }),
      path: Object.freeze(["f".repeat(255)]),
      type: "write_file" as const,
    }),
    Object.freeze({
      path: Object.freeze(["maximum-symlink-target"]),
      target: "t".repeat(4_096),
      type: "create_symlink" as const,
    }),
  ]),
});

const treeBackedDirectoryOperations = Object.freeze(
  Array.from({ length: 22 }, (_, index) => Object.freeze({
    bytes: Uint8Array.of(index),
    path: Object.freeze([
      "tree-directory",
      `entry-${index.toString().padStart(2, "0")}-${"x".repeat(180)}.bin`,
    ]),
    type: "write_file" as const,
  })),
);

export const largeFile600kScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "large-file-600k-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: Uint8Array.from({ length: 600_000 }, (_, index) => index % 251),
      path: Object.freeze(["multi-chunk.bin"]),
      type: "write_file" as const,
    }),
  ]),
});

export const multiChunkFileScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "multi-chunk-file-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: Uint8Array.from({ length: 1_100_000 }, (_, index) => index % 251),
      path: Object.freeze(["multi-chunk.bin"]),
      type: "write_file" as const,
    }),
  ]),
});

export const treeBackedFilesystemScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "tree-backed-directory-and-file-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["tree-directory"]), type: "mkdir" as const }),
    ...treeBackedDirectoryOperations,
    Object.freeze({
      bytes: Uint8Array.from({ length: 5_000 }, (_, index) => index % 251),
      path: Object.freeze(["large-file.bin"]),
      type: "write_file" as const,
    }),
  ]),
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
