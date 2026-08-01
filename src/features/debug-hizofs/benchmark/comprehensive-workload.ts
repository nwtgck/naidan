import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';

const FIXTURE_ROOT_NAME = '__hizofs_fixture__';
const DEEP_DIRECTORY_LEVEL_COUNT = 12;

export type HizoFSComprehensiveFixtureThresholds = Readonly<{
  directoryIndexPageEntryLimit: number;
  fileChunkSize: number;
  fileExtentIndexPageEntryLimit: number;
  inodeIndexPageEntryLimit: number;
  inlineDirectoryEntryLimit: number;
  inlineFileByteLimit: number;
}>;

export const HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH = `/${FIXTURE_ROOT_NAME}`;

export type HizoFSComprehensiveFixtureProgress = {
  readonly phase:
    | 'preparing'
    | 'directories'
    | 'files'
    | 'indexes'
    | 'symlinks'
    | 'mutations'
    | 'manifest'
    | 'complete';
  readonly completedPhaseCount: number;
  readonly totalPhaseCount: number;
  readonly detail: string;
};

export type HizoFSComprehensiveFixtureCase = {
  readonly id: string;
  readonly path: string;
  readonly purpose: string;
  readonly expectedStructures: readonly string[];
};

export type HizoFSComprehensiveFixtureResult = {
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly coverage: readonly HizoFSComprehensiveFixtureCase[];
};

/**
 * Builds a deterministic fixture through the public decrypted filesystem API.
 *
 * The generator intentionally does not write HizoFS records directly.
 * Every runtime node shape, persisted record, and control-plane transition must be a
 * consequence of the same filesystem operations a real caller performs. This
 * keeps the fixture useful for auditing the implementation rather than merely
 * fabricating DTOs that look structurally valid.
 *
 * The caller supplies thresholds from the current public implementation
 * policy. Keeping those values outside this debug module prevents the fixture
 * from becoming a second authority for persisted layout decisions.
 */
export async function generateHizoFSComprehensiveFixture({
  root,
  onProgress,
  thresholds,
}: {
  root: StorageDirectoryHandle;
  thresholds: HizoFSComprehensiveFixtureThresholds;
  onProgress: ({ progress }: {
    progress: HizoFSComprehensiveFixtureProgress;
  }) => void;
}): Promise<HizoFSComprehensiveFixtureResult> {
  const policy = validateFixtureThresholds({ thresholds });
  const coverage = createCoverageCases({ policy });
  const totalPhaseCount = 7;
  onProgress({
    progress: {
      phase: 'preparing',
      completedPhaseCount: 0,
      totalPhaseCount,
      detail: `Checking ${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}`,
    },
  });
  await assertFixtureRootDoesNotExist({ root });
  const fixtureRoot = await root.getDirectoryHandle({ name: FIXTURE_ROOT_NAME, create: true });

  onProgress({
    progress: {
      phase: 'directories',
      completedPhaseCount: 1,
      totalPhaseCount,
      detail: 'Creating inline, indexed, empty, deep, Unicode, and long-name directories',
    },
  });
  const directories = await createDirectoryCoverage({ fixtureRoot, policy });

  onProgress({
    progress: {
      phase: 'files',
      completedPhaseCount: 2,
      totalPhaseCount,
      detail: 'Creating empty, inline, extent-backed, sparse, and multi-chunk files',
    },
  });
  await createFileCoverage({ filesDirectory: directories.files, policy });

  onProgress({
    progress: {
      phase: 'indexes',
      completedPhaseCount: 3,
      totalPhaseCount,
      detail: 'Crossing inode, directory, and extent index page boundaries',
    },
  });
  await createIndexCoverage({
    indexedDirectory: directories.indexed,
    filesDirectory: directories.files,
    policy,
  });

  onProgress({
    progress: {
      phase: 'symlinks',
      completedPhaseCount: 4,
      totalPhaseCount,
      detail: 'Creating relative, absolute, directory, and dangling symbolic links',
    },
  });
  await createSymlinkCoverage({ linksDirectory: directories.links });

  onProgress({
    progress: {
      phase: 'mutations',
      completedPhaseCount: 5,
      totalPhaseCount,
      detail: 'Creating partial-write, truncate, move, rename, and delete history',
    },
  });
  await createMutationCoverage({ operationsDirectory: directories.operations, policy });

  onProgress({
    progress: {
      phase: 'manifest',
      completedPhaseCount: 6,
      totalPhaseCount,
      detail: 'Writing the fixture manifest as an ordinary filesystem file',
    },
  });
  const manifestPath = `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/manifest.json`;
  await writeStorageFileText({
    fileHandle: await fixtureRoot.getFileHandle({ name: 'manifest.json', create: true }),
    value: JSON.stringify({
      fixtureVersion: 1,
      purpose: 'HizoFS persisted data-structure coverage',
      policy,
      coverage,
    }, undefined, 2),
  });

  onProgress({
    progress: {
      phase: 'complete',
      completedPhaseCount: totalPhaseCount,
      totalPhaseCount,
      detail: 'Comprehensive fixture generated',
    },
  });
  return {
    rootPath: HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH,
    manifestPath,
    coverage,
  };
}

async function createDirectoryCoverage({ fixtureRoot, policy }: {
  fixtureRoot: StorageDirectoryHandle;
  policy: HizoFSComprehensiveFixtureThresholds;
}): Promise<{
  readonly files: StorageDirectoryHandle;
  readonly indexed: StorageDirectoryHandle;
  readonly links: StorageDirectoryHandle;
  readonly operations: StorageDirectoryHandle;
}> {
  const directories = await fixtureRoot.getDirectoryHandle({ name: 'directories', create: true });
  await directories.getDirectoryHandle({ name: 'empty', create: true });
  const mixed = await directories.getDirectoryHandle({ name: 'mixed', create: true });
  await mixed.getDirectoryHandle({ name: 'child-directory', create: true });
  await mixed.getFileHandle({ name: 'child-file.txt', create: true });

  let deep = await directories.getDirectoryHandle({ name: 'deep', create: true });
  for (let level = 1; level <= DEEP_DIRECTORY_LEVEL_COUNT; level += 1) {
    deep = await deep.getDirectoryHandle({
      name: `level-${String(level).padStart(2, '0')}`,
      create: true,
    });
  }
  await writeStorageFileText({
    fileHandle: await deep.getFileHandle({ name: 'leaf.txt', create: true }),
    value: 'Deep directory traversal leaf',
  });

  const names = await directories.getDirectoryHandle({ name: 'names', create: true });
  await names.getDirectoryHandle({ name: '日本語-ディレクトリ', create: true });
  await names.getFileHandle({ name: `long-${'x'.repeat(120)}.txt`, create: true });

  const indexed = await directories.getDirectoryHandle({ name: 'indexed', create: true });
  for (let index = 0; index < policy.inlineDirectoryEntryLimit + 2; index += 1) {
    await indexed.getFileHandle({
      name: `inline-promotion-${String(index).padStart(3, '0')}.txt`,
      create: true,
    });
  }

  const files = await fixtureRoot.getDirectoryHandle({ name: 'files', create: true });
  const links = await fixtureRoot.getDirectoryHandle({ name: 'links', create: true });
  const operations = await fixtureRoot.getDirectoryHandle({ name: 'operations', create: true });
  return { files, indexed, links, operations };
}

async function createFileCoverage({ filesDirectory, policy }: {
  filesDirectory: StorageDirectoryHandle;
  policy: HizoFSComprehensiveFixtureThresholds;
}): Promise<void> {
  await filesDirectory.getFileHandle({ name: 'empty.bin', create: true });
  await writeFileBytes({
    fileHandle: await filesDirectory.getFileHandle({ name: 'inline-small.txt', create: true }),
    bytes: new TextEncoder().encode('HizoFS inline fixture'),
  });
  await writeFileBytes({
    fileHandle: await filesDirectory.getFileHandle({ name: 'inline-boundary.bin', create: true }),
    bytes: createPatternBytes({ byteLength: policy.inlineFileByteLimit, seed: 0x11 }),
  });
  await writeFileBytes({
    fileHandle: await filesDirectory.getFileHandle({ name: 'extent-single-chunk.bin', create: true }),
    bytes: createPatternBytes({ byteLength: policy.inlineFileByteLimit + 1, seed: 0x22 }),
  });
  await writeFileBytes({
    fileHandle: await filesDirectory.getFileHandle({ name: 'extent-multi-chunk.bin', create: true }),
    bytes: createPatternBytes({ byteLength: policy.fileChunkSize * 2 + 17, seed: 0x33 }),
  });

  const sparse = await filesDirectory.getFileHandle({ name: 'sparse.bin', create: true });
  const sparseWriter = await sparse.createWritable({ keepExistingData: false });
  try {
    await sparseWriter.write({ position: 0, data: new Uint8Array([0x41]) });
    await sparseWriter.write({
      position: policy.fileChunkSize * 8 + 17,
      data: new Uint8Array([0x5a]),
    });
    await sparseWriter.close();
  } catch (error) {
    await abortWriter({ writer: sparseWriter, error });
    throw error;
  }
}

async function createIndexCoverage({ indexedDirectory, filesDirectory, policy }: {
  indexedDirectory: StorageDirectoryHandle;
  filesDirectory: StorageDirectoryHandle;
  policy: HizoFSComprehensiveFixtureThresholds;
}): Promise<void> {
  for (let index = policy.inlineDirectoryEntryLimit + 2; index < policy.directoryIndexPageEntryLimit + 1; index += 1) {
    await indexedDirectory.getFileHandle({
      name: `index-branch-${String(index).padStart(3, '0')}.txt`,
      create: true,
    });
  }

  const extentIndexed = await filesDirectory.getFileHandle({ name: 'extent-index-branch.bin', create: true });
  const writer = await extentIndexed.createWritable({ keepExistingData: false });
  try {
    for (let chunkIndex = 0; chunkIndex < policy.fileExtentIndexPageEntryLimit + 1; chunkIndex += 1) {
      await writer.write({
        position: chunkIndex * policy.fileChunkSize,
        data: new Uint8Array([(chunkIndex % 251) + 1]),
      });
    }
    await writer.close();
  } catch (error) {
    await abortWriter({ writer, error });
    throw error;
  }
}

async function createSymlinkCoverage({ linksDirectory }: {
  linksDirectory: StorageDirectoryHandle;
}): Promise<void> {
  await linksDirectory.createSymlink({
    name: 'relative-file',
    target: '../files/inline-small.txt',
  });
  await linksDirectory.createSymlink({
    name: 'relative-directory',
    target: '../directories/deep',
  });
  await linksDirectory.createSymlink({
    name: 'absolute-directory',
    target: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/directories/indexed`,
  });
  await linksDirectory.createSymlink({
    name: 'dangling',
    target: '../missing-target',
  });
}

async function createMutationCoverage({ operationsDirectory, policy }: {
  operationsDirectory: StorageDirectoryHandle;
  policy: HizoFSComprehensiveFixtureThresholds;
}): Promise<void> {
  const partialWrite = await operationsDirectory.getFileHandle({ name: 'partial-write.txt', create: true });
  await writeFileBytes({
    fileHandle: partialWrite,
    bytes: new TextEncoder().encode('abcdefghij'),
  });
  const partialWriter = await partialWrite.createWritable({ keepExistingData: true });
  try {
    await partialWriter.write({ position: 3, data: new TextEncoder().encode('XYZ') });
    await partialWriter.close();
  } catch (error) {
    await abortWriter({ writer: partialWriter, error });
    throw error;
  }

  const truncated = await operationsDirectory.getFileHandle({ name: 'extent-then-truncated.bin', create: true });
  await writeFileBytes({
    fileHandle: truncated,
    bytes: createPatternBytes({ byteLength: policy.inlineFileByteLimit + 1, seed: 0x44 }),
  });
  const truncateWriter = await truncated.createWritable({ keepExistingData: true });
  try {
    await truncateWriter.truncate({ size: 31 });
    await truncateWriter.close();
  } catch (error) {
    await abortWriter({ writer: truncateWriter, error });
    throw error;
  }

  const movedDirectory = await operationsDirectory.getDirectoryHandle({ name: 'moved', create: true });
  const original = await operationsDirectory.getFileHandle({ name: 'original-name.txt', create: true });
  await writeStorageFileText({ fileHandle: original, value: 'stable node moved and renamed' });
  await operationsDirectory.moveEntry({
    name: 'original-name.txt',
    destination: movedDirectory,
    newName: 'renamed.txt',
    replace: false,
  });

  const deleted = await operationsDirectory.getFileHandle({ name: 'deleted-after-write.txt', create: true });
  await writeStorageFileText({ fileHandle: deleted, value: 'This object should become unreachable.' });
  await operationsDirectory.removeEntry({ name: 'deleted-after-write.txt', recursive: false });
}

function createCoverageCases({ policy }: {
  policy: HizoFSComprehensiveFixtureThresholds;
}): readonly HizoFSComprehensiveFixtureCase[] {
  return [
    {
      id: 'empty-directory',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/directories/empty`,
      purpose: 'Empty inline directory inode',
      expectedStructures: ['runtime:directory_inode:inline', 'persisted:inode_table_page'],
    },
    {
      id: 'deep-directory',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/directories/deep`,
      purpose: 'Deep logical directory traversal',
      expectedStructures: ['runtime:directory_inode:inline', 'persisted:inode_table_page'],
    },
    {
      id: 'indexed-directory',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/directories/indexed`,
      purpose: `Directory with more than ${String(policy.inlineDirectoryEntryLimit)} entries`,
      expectedStructures: ['runtime:directory_inode:indexed', 'persisted:inode_table_page', 'persisted:directory_page'],
    },
    {
      id: 'inline-file',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/files/inline-small.txt`,
      purpose: 'Inline file inode and binary payload',
      expectedStructures: ['runtime:file_inode:inline', 'persisted:inode_table_page'],
    },
    {
      id: 'inline-boundary',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/files/inline-boundary.bin`,
      purpose: `Inline file at the ${String(policy.inlineFileByteLimit)} byte boundary`,
      expectedStructures: ['runtime:file_inode:inline', 'persisted:inode_table_page'],
    },
    {
      id: 'extent-file',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/files/extent-single-chunk.bin`,
      purpose: 'File immediately above the inline boundary',
      expectedStructures: ['runtime:file_inode:extents', 'persisted:inode_table_page', 'persisted:file_extent_page', 'persisted:file_data'],
    },
    {
      id: 'extent-index-branch',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/files/extent-index-branch.bin`,
      purpose: `Extent index with more than ${String(policy.fileExtentIndexPageEntryLimit)} entries`,
      expectedStructures: ['persisted:file_extent_page', 'persisted:file_data'],
    },
    {
      id: 'sparse-file',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/files/sparse.bin`,
      purpose: 'Missing extent entries representing zero-filled sparse ranges',
      expectedStructures: ['runtime:file_inode:extents', 'persisted:inode_table_page', 'persisted:file_extent_page', 'persisted:file_data'],
    },
    {
      id: 'symlinks',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/links`,
      purpose: 'Relative, absolute, directory, and dangling symlink inodes',
      expectedStructures: ['runtime:symlink_inode', 'persisted:inode_table_page'],
    },
    {
      id: 'copy-on-write-history',
      path: `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH}/operations`,
      purpose: 'Partial writes, extent-to-inline truncation, move, rename, and deletion history',
      expectedStructures: ['persisted:file_system_commit', 'control-plane:superblock', 'runtime:unreachable_immutable_records'],
    },
    {
      id: 'inode-index-branch',
      path: HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH,
      purpose: `More than ${String(policy.inodeIndexPageEntryLimit)} filesystem nodes`,
      expectedStructures: ['persisted:inode_table_page'],
    },
  ];
}

function validateFixtureThresholds({ thresholds }: {
  thresholds: HizoFSComprehensiveFixtureThresholds;
}): HizoFSComprehensiveFixtureThresholds {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`HizoFS fixture threshold ${name} must be a positive safe integer`);
    }
  }
  return { ...thresholds };
}

async function assertFixtureRootDoesNotExist({ root }: {
  root: StorageDirectoryHandle;
}): Promise<void> {
  try {
    await root.getEntryHandle({ name: FIXTURE_ROOT_NAME });
  } catch (error) {
    if (isNotFoundError({ error })) return;
    throw error;
  }
  throw new Error(
    `${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH} already exists. Remove it or create a new ephemeral workspace before generating the fixture.`,
  );
}

async function writeFileBytes({ fileHandle, bytes }: {
  fileHandle: StorageFileHandle;
  bytes: Uint8Array;
}): Promise<void> {
  const writer = await fileHandle.createWritable({ keepExistingData: false });
  try {
    if (bytes.byteLength > 0) {
      await writer.write({ position: 0, data: bytes });
    }
    await writer.close();
  } catch (error) {
    await abortWriter({ writer, error });
    throw error;
  }
}

async function abortWriter({ writer, error }: {
  writer: StorageWritableFile;
  error: unknown;
}): Promise<void> {
  try {
    await writer.abort({ reason: error });
  } catch {
    // Preserve the original write failure.
  }
}

function createPatternBytes({ byteLength, seed }: {
  byteLength: number;
  seed: number;
}): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (seed + index * 31) % 251;
  }
  return bytes;
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error && error.name === 'NotFoundError';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEEP_DIRECTORY_LEVEL_COUNT,
  FIXTURE_ROOT_NAME,
};
