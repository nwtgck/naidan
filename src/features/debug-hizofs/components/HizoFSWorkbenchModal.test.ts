import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HizoFSBinaryRecordInspectionView,
  HizoFSInspectionWorkerClient,
  HizoFSResolvedNodeView,
} from "@/features/debug-hizofs/worker/types";
import type {
  HizoFSWorkbenchSource,
  HizoFSWorkbenchSourceSession,
} from "@/features/debug-hizofs/logic/workbench-sources";
import HizoFSWorkbenchModal from "./HizoFSWorkbenchModal.vue";

type OverviewResult = Awaited<
  ReturnType<HizoFSInspectionWorkerClient["readOverview"]>
>;
type InspectedObjectResult = Awaited<
  ReturnType<HizoFSInspectionWorkerClient["inspectObject"]>
>;
type NamespaceResult = Awaited<
  ReturnType<HizoFSInspectionWorkerClient["readNamespace"]>
>;
type IntegrityResult = Awaited<
  ReturnType<HizoFSInspectionWorkerClient["runIntegrityScan"]>
>;

function createBinaryRecordInspection({
  recordKindId,
  recordKind,
  metadata,
  binaryPayload,
}: {
  recordKindId: number;
  recordKind: string;
  metadata: unknown;
  binaryPayload: Uint8Array;
}): HizoFSBinaryRecordInspectionView {
  const metadataText = JSON.stringify(metadata);
  const metadataBytes = new TextEncoder().encode(metadataText);
  const persistedBytes = new Uint8Array(64);
  persistedBytes.set([0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00], 0);
  persistedBytes.set([0x00, 0x01, 0x00, 0x20], 8);
  persistedBytes.set(new Uint8Array(12).fill(0xa5), 12);
  new DataView(persistedBytes.buffer).setBigUint64(24, 32n, false);

  const plaintext = new Uint8Array(16 + metadataBytes.byteLength + binaryPayload.byteLength);
  plaintext[0] = recordKindId;
  plaintext[1] = 0;
  const plaintextView = new DataView(plaintext.buffer);
  plaintextView.setUint16(2, 1, false);
  plaintextView.setUint32(4, metadataBytes.byteLength, false);
  plaintextView.setBigUint64(8, BigInt(binaryPayload.byteLength), false);
  plaintext.set(metadataBytes, 16);
  plaintext.set(binaryPayload, 16 + metadataBytes.byteLength);

  return {
    persistedObject: {
      bytes: {
        offset: 0,
        regionByteLength: persistedBytes.byteLength,
        bytes: persistedBytes,
        truncatedAfter: false,
      },
      headerFields: [
        {
          name: "magic",
          offset: 0,
          byteLength: 8,
          rawBytes: persistedBytes.slice(0, 8),
          encoding: "ascii",
          interpretation: '"HIZOFS\\0\\0"',
        },
        {
          name: "formatVersion",
          offset: 8,
          byteLength: 2,
          rawBytes: persistedBytes.slice(8, 10),
          encoding: "uint16_be",
          interpretation: "1",
        },
        {
          name: "headerByteLength",
          offset: 10,
          byteLength: 2,
          rawBytes: persistedBytes.slice(10, 12),
          encoding: "uint16_be",
          interpretation: "32 bytes",
        },
        {
          name: "nonce",
          offset: 12,
          byteLength: 12,
          rawBytes: persistedBytes.slice(12, 24),
          encoding: "bytes",
          interpretation: "12-byte AES-GCM nonce",
        },
        {
          name: "ciphertextByteLength",
          offset: 24,
          byteLength: 8,
          rawBytes: persistedBytes.slice(24, 32),
          encoding: "uint64_be",
          interpretation: "32 bytes including authentication tag",
        },
      ],
      ciphertextOffset: 32,
      ciphertextByteLength: 32,
    },
    decryptedRecord: {
      bytes: {
        offset: 0,
        regionByteLength: plaintext.byteLength,
        bytes: plaintext,
        truncatedAfter: false,
      },
      headerFields: [
        {
          name: "recordKind",
          offset: 0,
          byteLength: 1,
          rawBytes: plaintext.slice(0, 1),
          encoding: "uint8",
          interpretation: `${String(recordKindId)} (${recordKind})`,
        },
        {
          name: "payloadEncoding",
          offset: 1,
          byteLength: 1,
          rawBytes: plaintext.slice(1, 2),
          encoding: "uint8",
          interpretation: "0 (identity)",
        },
        {
          name: "recordVersion",
          offset: 2,
          byteLength: 2,
          rawBytes: plaintext.slice(2, 4),
          encoding: "uint16_be",
          interpretation: "1",
        },
        {
          name: "metadataJsonByteLength",
          offset: 4,
          byteLength: 4,
          rawBytes: plaintext.slice(4, 8),
          encoding: "uint32_be",
          interpretation: `${String(metadataBytes.byteLength)} bytes`,
        },
        {
          name: "binaryPayloadByteLength",
          offset: 8,
          byteLength: 8,
          rawBytes: plaintext.slice(8, 16),
          encoding: "uint64_be",
          interpretation: `${String(binaryPayload.byteLength)} bytes`,
        },
      ],
      metadataJson: {
        bytes: {
          offset: 16,
          regionByteLength: metadataBytes.byteLength,
          bytes: metadataBytes,
          truncatedAfter: false,
        },
        utf8Text: metadataText,
      },
      binaryPayload: {
        offset: 16 + metadataBytes.byteLength,
        regionByteLength: binaryPayload.byteLength,
        bytes: new Uint8Array(binaryPayload),
        truncatedAfter: false,
      },
    },
  };
}


function limitBinaryPreview({
  binary,
  binaryPreviewByteLength,
}: {
  binary: HizoFSBinaryRecordInspectionView;
  binaryPreviewByteLength: number;
}): HizoFSBinaryRecordInspectionView {
  function sliceRegion({
    region,
    previewByteLength,
  }: {
    region: HizoFSBinaryRecordInspectionView["persistedObject"]["bytes"];
    previewByteLength: number;
  }) {
    const bytes = region.bytes.slice(0, Math.min(region.regionByteLength, previewByteLength));
    return {
      ...region,
      bytes,
      truncatedAfter: bytes.byteLength < region.regionByteLength,
    };
  }

  return {
    persistedObject: {
      ...binary.persistedObject,
      bytes: sliceRegion({
        region: binary.persistedObject.bytes,
        previewByteLength: Math.max(32, binaryPreviewByteLength),
      }),
    },
    decryptedRecord: {
      ...binary.decryptedRecord,
      bytes: sliceRegion({
        region: binary.decryptedRecord.bytes,
        previewByteLength: Math.max(16, binaryPreviewByteLength),
      }),
      metadataJson: {
        bytes: sliceRegion({
          region: binary.decryptedRecord.metadataJson.bytes,
          previewByteLength: binaryPreviewByteLength,
        }),
        utf8Text: binaryPreviewByteLength >= binary.decryptedRecord.metadataJson.bytes.regionByteLength
          ? binary.decryptedRecord.metadataJson.utf8Text
          : undefined,
      },
      binaryPayload: sliceRegion({
        region: binary.decryptedRecord.binaryPayload,
        previewByteLength: binaryPreviewByteLength,
      }),
    },
  };
}

const mocks = vi.hoisted(() => ({
  closeWorkbench: vi.fn(),
  createBenchmarkClient: vi.fn(),
  createClient: vi.fn(),
  createWorkspace: vi.fn(),
  generateFixture: vi.fn(),
  destroyWorkspace: vi.fn(),
  listSources: vi.fn(),
  openControlPlane: vi.fn(),
  openFileExplorer: vi.fn(),
  openSource: vi.fn(),
}));

vi.mock(
  "@/features/debug-hizofs/composables/useDebugHizoFSWorkbench",
  () => ({
    useDebugHizoFSWorkbench: () => ({
      closeDebugHizoFSWorkbench: mocks.closeWorkbench,
    }),
  }),
);

vi.mock(
  "@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector",
  () => ({
    useDebugOpfsEncryptionInspector: () => ({
      openDebugOpfsEncryptionInspector: mocks.openControlPlane,
    }),
  }),
);

vi.mock("@/features/debug-hizofs/logic/workbench-sources", () => ({
  listHizoFSWorkbenchSources: mocks.listSources,
  createHizoFSWorkbenchWorkspace: mocks.createWorkspace,
  destroyHizoFSWorkbenchWorkspace: mocks.destroyWorkspace,
  openHizoFSWorkbenchSource: mocks.openSource,
}));

vi.mock("@/features/debug-hizofs/logic/comprehensive-fixture", () => ({
  HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH: "/__hizofs_fixture__",
  generateHizoFSComprehensiveFixture: mocks.generateFixture,
}));

vi.mock("@/features/debug-hizofs/worker/client", () => ({
  createHizoFSBenchmarkWorkerClient: mocks.createBenchmarkClient,
  createHizoFSInspectionWorkerClient: mocks.createClient,
}));

vi.mock("@/features/file-explorer/composables/useFileExplorerModal", () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock("@/features/file-explorer/components/FileExplorer.vue", () => ({
  default: {
    props: ["root", "initialLocked", "initialPreviewVisibility", "revealPath", "revealFilePreview", "entryContextActionLabel"],
    emits: ["entry-context-action"],
    setup(_: unknown, { emit }: { emit: (event: string, payload: unknown) => void }) {
      return {
        inspectDocs() {
          emit("entry-context-action", {
            entry: {
              path: "/docs",
              name: "docs",
              kind: "directory",
              size: undefined,
              lastModified: undefined,
              extension: "",
              mimeCategory: "binary",
              readOnly: true,
              canNavigate: true,
              canMutate: false,
            },
          });
        },
      };
    },
    template: '<div data-testid="embedded-file-explorer">{{ root.kind }}:{{ root.rootName }}:{{ String(initialLocked) }}:{{ initialPreviewVisibility }}:{{ revealFilePreview }}:{{ revealPath ?? "" }}:{{ entryContextActionLabel ?? "" }}<button type="button" data-testid="mock-inspect-hizofs-records" @click="inspectDocs">Inspect</button></div>',
  },
}));

vi.mock("@/features/json-viewer", () => ({
  JsonCodeView: {
    props: ["source"],
    template: '<pre data-testid="json-code-view">{{ source }}</pre>',
  },
}));

const activeSource: Extract<
  HizoFSWorkbenchSource,
  { readonly type: "naidan_active_store" }
> = {
  type: "naidan_active_store",
  sourceId: "naidan-active-store",
  label: "Naidan active encrypted store",
  access: "read_only",
  encryptedStoreId: "store-a",
};

const workspaceSource: Extract<
  HizoFSWorkbenchSource,
  { readonly type: "ephemeral_debug_workspace" }
> = {
  type: "ephemeral_debug_workspace",
  sourceId: "debug-workspace:workspace-a",
  label: "Ephemeral workspace workspace",
  access: "read_write",
  workspace: {
    status: "live",
    workspaceId: "workspace-a",
    createdAt: 1,
    fileSystemId: "filesystem-debug",
    physicalPath: ["naidan-debug-hizofs", "runtime-workspace-a.hizofs"],
  },
};

function createSourceSession({
  source,
  fileSystemId,
}: {
  source: HizoFSWorkbenchSourceSession["source"];
  fileSystemId: string;
}): HizoFSWorkbenchSourceSession {
  return {
    source,
    fileSystemId,
    physicalPath: ["naidan-storage", "encrypted-stores", "store-a", "filesystem.hizofs"],
    decryptedRoot: {
      kind: "directory",
      name: "",
    } as HizoFSWorkbenchSourceSession["decryptedRoot"],
    hizoFSReader:
      {} as HizoFSWorkbenchSourceSession["hizoFSReader"],
    dispose: vi.fn(async () => {}),
  };
}

function createClient({
  fileSystemId,
}: {
  fileSystemId: string;
}): HizoFSInspectionWorkerClient {
  const superblockMetadata = {
    sequence: 4,
    fileSystemId,
    activeCommitObjectId: "commit-a",
  };
  const commitMetadata = {
    revision: 5,
    rootDirectoryNodeId: "root-a",
    inodeIndexRootObjectId: "inode-index-a",
  };
  const fullSuperblockBinary = createBinaryRecordInspection({
    recordKindId: 9,
    recordKind: "superblock",
    metadata: superblockMetadata,
    binaryPayload: new Uint8Array(),
  });
  const fullObjectBinary = createBinaryRecordInspection({
    recordKindId: 1,
    recordKind: "commit",
    metadata: commitMetadata,
    binaryPayload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  });
  const overview: OverviewResult = {
    activeMode: 'fallback_read_only',
    descriptor: { format: 'hizofs', formatVersion: 1 },
    fileSystemId,
    persistedDescriptorDto: {
      format: 'hizofs',
      formatVersion: 1,
      unknownPersistedField: "must remain visible",
    },
    descriptorValidationError: 'Unrecognized key: unknownPersistedField',
    superblockSlots: [
      {
        slot: 0,
        status: "valid",
        selected: true,
        physicalPath: ["superblock-0.enc"],
        value: superblockMetadata,
        persistedDto: superblockMetadata,
        binary: limitBinaryPreview({
          binary: fullSuperblockBinary,
          binaryPreviewByteLength: 0,
        }),
      },
      {
        slot: 1,
        status: "missing",
        selected: false,
        physicalPath: ["superblock-1.enc"],
      },
    ],
    activeSuperblock: {
      sequence: 4,
      fileSystemId,
      activeCommitObjectId: "commit-a",
    },
    activeCommitObjectId: "commit-a",
    activeCommit: commitMetadata,
    activeCommitPersistedDto: {
      revision: 5,
      rootDirectoryNodeId: "root-a",
      inodeIndexRootObjectId: "inode-index-a",
      unknownPersistedField: "must remain visible",
    },
  };
  const inspectedObject: Exclude<InspectedObjectResult, undefined> = {
    object: {
      objectId: "object-a",
      physicalPath: ["objects", "00", "object-a.enc"],
      physicalByteLength: 64,
      binary: limitBinaryPreview({
        binary: fullObjectBinary,
        binaryPreviewByteLength: 0,
      }),
      record: {
        kind: "commit",
        recordVersion: 1,
        metadata: commitMetadata,
        binaryPayloadByteLength: 4,
      },
    },
    validation: {
      status: "valid",
      persistedDto: commitMetadata,
    },
    references: [{ relation: "inode index root", objectId: "inode-index-a" }],
    rootDirectoryEntryPoint: {
      commitObjectId: "object-a",
      revision: 5,
      rootDirectoryNodeId: "root-a",
      inodeIndexRootObjectId: "inode-index-a",
    },
  };
  const resolvedRoot: HizoFSResolvedNodeView = {
    commitObjectId: "commit-a",
    commitRevision: 5,
    rootDirectoryNodeId: "root-a",
    inodeIndexRootObjectId: "inode-index-a",
    nodeId: "root-a",
    logicalPath: "/",
    inodeIndexLookup: [{
      type: "leaf",
      pageObjectId: "inode-index-a",
      inodeObjectId: "root-inode-a",
    }],
    inodeObjectId: "root-inode-a",
    inodeKind: "directory",
    inodePersistedDto: {
      nodeId: "root-a",
      revision: 5,
      createdAt: null,
      modifiedAt: null,
      storage: {
        type: "inline",
        entries: [{ name: "docs", kind: "directory", nodeId: "docs-node" }],
      },
    },
    binaryPayloadByteLength: 0,
    directory: {
      storageType: "inline",
      directoryIndexRootObjectId: undefined,
      entries: [{
        entry: { name: "docs", kind: "directory", nodeId: "docs-node" },
        source: { type: "inline", directoryInodeObjectId: "root-inode-a" },
      }],
      truncated: false,
      issues: [],
    },
  };
  const resolvedDocs: HizoFSResolvedNodeView = {
    ...resolvedRoot,
    nodeId: "docs-node",
    logicalPath: "/docs",
    inodeObjectId: "docs-inode-a",
    inodeIndexLookup: [{
      type: "leaf",
      pageObjectId: "inode-index-a",
      inodeObjectId: "docs-inode-a",
    }],
    inodePersistedDto: {
      nodeId: "docs-node",
      revision: 5,
      createdAt: null,
      modifiedAt: null,
      storage: { type: "inline", entries: [] },
    },
    directory: {
      storageType: "inline",
      directoryIndexRootObjectId: undefined,
      entries: [],
      truncated: false,
      issues: [],
    },
  };
  const namespace: NamespaceResult = {
    entries: [
      {
        path: "/settings.json",
        name: "settings.json",
        kind: "file",
        nodeId: "node-a",
        inodeObjectId: "object-a",
        revision: 2,
        size: 12,
        storage: "inline",
      },
    ],
    truncated: false,
    issues: [],
  };
  const integrity: IntegrityResult = {
    activeCommitObjectId: "commit-a",
    activeReachableObjectCount: 4,
    fallbackReachableObjectCount: 2,
    reachableObjectCount: 5,
    fallbackOnlyObjectIds: ["fallback-a"],
    physicalObjectCount: 6,
    orphanObjectIds: ["orphan-a"],
    ignoredPhysicalPaths: [],
    recordKindCounts: { commit: 1 },
    totalBinaryPayloadBytes: 12,
    issues: [],
  };

  return {
    readOverview: vi.fn(async () => overview),
    listPhysicalObjects: vi.fn(async () => ({
      entries: [
        {
          objectId: "object-a",
          physicalPath: ["objects", "00", "object-a.enc"],
        },
      ],
      nextCursor: undefined,
      ignoredPhysicalPaths: [],
    })),
    inspectObject: vi.fn(async ({ binaryPreviewByteLength }) => ({
      ...inspectedObject,
      object: {
        ...inspectedObject.object,
        binary: limitBinaryPreview({
          binary: fullObjectBinary,
          binaryPreviewByteLength,
        }),
      },
    })),
    inspectSuperblockSlot: vi.fn(async ({ slot, binaryPreviewByteLength }) => {
      const inspected = overview.superblockSlots.find(candidate => candidate.slot === slot);
      if (inspected === undefined) throw new Error(`Missing mock superblock slot: ${String(slot)}`);
      return inspected.status === "valid"
        ? {
          ...inspected,
          binary: limitBinaryPreview({
            binary: fullSuperblockBinary,
            binaryPreviewByteLength,
          }),
        }
        : inspected;
    }),
    readNode: vi.fn(async ({ nodeId }) => nodeId === "root-a" ? resolvedRoot : resolvedDocs),
    readPath: vi.fn(async ({ logicalPath }) => logicalPath === "/" ? [resolvedRoot] : [resolvedRoot, resolvedDocs]),
    readNamespace: vi.fn(async () => namespace),
    runIntegrityScan: vi.fn(async () => integrity),
    runBenchmark: vi.fn(async () => {
      throw new Error('benchmark not configured in this test');
    }),
    cleanBenchmarkData: vi.fn(async () => {}),
    cancelCurrentOperation: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

describe("HizoFSWorkbenchModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSources.mockResolvedValue([activeSource, workspaceSource]);
    mocks.openSource.mockImplementation(
      async ({
        source,
      }: {
        source: HizoFSWorkbenchSourceSession["source"];
      }) =>
        createSourceSession({
          source,
          fileSystemId:
            source.type === "naidan_active_store"
              ? "filesystem-a"
              : "filesystem-debug",
        }),
    );
    mocks.createClient.mockResolvedValue(
      createClient({ fileSystemId: "filesystem-a" }),
    );
    mocks.createWorkspace.mockResolvedValue(workspaceSource);
    mocks.generateFixture.mockImplementation(async ({ onProgress }) => {
      onProgress({
        progress: {
          phase: "complete",
          completedPhaseCount: 7,
          totalPhaseCount: 7,
          detail: "Comprehensive fixture generated",
        },
      });
      return {
        rootPath: "/__hizofs_fixture__",
        manifestPath: "/__hizofs_fixture__/manifest.json",
        coverage: [
          {
            id: "inline-file",
            path: "/__hizofs_fixture__/files/inline-small.txt",
            purpose: "Inline file inode",
            expectedStructures: ["file_inode:inline"],
          },
        ],
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts from the HizoFS source and exposes low-level persisted records before derived views", async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.textContent).toContain("HizoFS Workbench");
    expect(document.body.textContent).toContain("Sources");
    expect(document.body.textContent).toContain(
      "Naidan active encrypted store",
    );
    expect(document.body.textContent).toContain("Descriptor");
    expect(document.body.textContent).toContain("Superblock slots");
    expect(document.body.textContent).toContain("Active commit");
    expect(document.body.textContent).toContain("Physical object store");
    expect(document.body.textContent).toContain("Logical filesystem views");
    expect(document.body.textContent).toContain("mutationdisabled in Workbench");
    expect(document.body.textContent).toContain("fallback_read_only");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-descriptor"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.textContent).toContain(
      "Raw DTO · exact persisted representation",
    );
    expect(document.body.textContent).toContain(
      '"format": "hizofs"',
    );
    expect(document.body.textContent).toContain(
      '"unknownPersistedField": "must remain visible"',
    );

    wrapper.unmount();
  });

  it("marks File Explorer as derived and passes the decrypted HizoFS root directly", async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-derived-views"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-derived-file-explorer"]',
      )
      ?.click();
    await flushPromises();

    expect(document.body.textContent).toContain(
      "Derived filesystem view · read_only",
    );
    expect(document.body.textContent).toContain(
      "storage-directory:Naidan active encrypted store root:true",
    );

    const workspaceButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[data-testid="hizofs-source"]',
      ),
    ).find((button) => button.dataset.sourceId === workspaceSource.sourceId);
    if (workspaceButton === undefined)
      throw new Error("Ephemeral source button was not rendered");
    workspaceButton.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-derived-views"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-derived-file-explorer"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.textContent).toContain(
      "storage-directory:Ephemeral workspace workspace root:false",
    );
    expect(document.body.textContent).toContain("root keyrandom · memory only");
    expect(document.body.textContent).toContain("key slotsnone");
    expect(document.body.textContent).toContain("reloadcannot reopen");

    wrapper.unmount();
  });

  it("keeps superblock DTO and references immediate while loading its binary representation on demand", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-superblocks"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-superblock-slot"]',
      )
      ?.click();
    await flushPromises();

    expect(client.inspectSuperblockSlot).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('"activeCommitObjectId": "commit-a"');
    expect(document.body.textContent).toContain("Persisted references");
    expect(document.body.textContent).toContain("activeCommitObjectId");
    expect(document.body.textContent).not.toContain("Authenticated persisted frame fields");

    const binaryDetails = document.body.querySelector<HTMLDetailsElement>(
      '[data-testid="hizofs-binary-representation-details"]',
    );
    if (binaryDetails === null) throw new Error("Superblock binary details were missing");
    binaryDetails.open = true;
    binaryDetails.dispatchEvent(new Event("toggle"));
    await flushPromises();

    expect(client.inspectSuperblockSlot).toHaveBeenCalledWith({
      slot: 0,
      binaryPreviewByteLength: 64 * 1024,
    });
    expect(document.body.textContent).toContain("Authenticated persisted frame fields");
    expect(document.body.textContent).toContain("48 49 5a 4f 46 53 00 00");

    wrapper.unmount();
  });

  it("prioritizes the record header, Raw DTO, and references before lazily loading binary details", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-object-store"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-object-entry"]',
      )
      ?.click();
    await flushPromises();

    expect(client.inspectObject).toHaveBeenCalledWith({
      objectId: "object-a",
      binaryPreviewByteLength: 0,
    });
    expect(document.body.textContent).toContain("Record header · decrypted binary framing");
    expect(document.body.textContent).toContain(
      "Raw DTO · parsed only from the actual metadata JSON range",
    );
    expect(document.body.textContent).toContain('"revision": 5');
    expect(document.body.textContent).toContain("Persisted references · continue traversal");
    expect(document.body.textContent).toContain("inode index root");
    expect(document.body.textContent).not.toContain("Authenticated persisted frame fields");
    expect(document.body.textContent).not.toContain("48 49 5a 4f 46 53 00 00");

    const objectColumnText = document.body.textContent ?? "";
    expect(objectColumnText.indexOf("Record header · decrypted binary framing"))
      .toBeLessThan(objectColumnText.indexOf("Raw DTO · parsed only from the actual metadata JSON range"));
    expect(objectColumnText.indexOf("Raw DTO · parsed only from the actual metadata JSON range"))
      .toBeLessThan(objectColumnText.indexOf("Persisted references · continue traversal"));
    expect(objectColumnText.indexOf("Persisted references · continue traversal"))
      .toBeLessThan(objectColumnText.indexOf("Binary representation · 64 persisted bytes · lazy"));

    const binaryDetails = document.body.querySelector<HTMLDetailsElement>(
      '[data-testid="hizofs-binary-representation-details"]',
    );
    if (binaryDetails === null) throw new Error("Binary representation details were missing");
    binaryDetails.open = true;
    binaryDetails.dispatchEvent(new Event("toggle"));
    await flushPromises();

    expect(client.inspectObject).toHaveBeenLastCalledWith({
      objectId: "object-a",
      binaryPreviewByteLength: 64 * 1024,
    });
    expect(document.body.textContent).toContain("Authenticated persisted frame fields");
    expect(document.body.textContent).toContain("48 49 5a 4f 46 53 00 00");
    expect(document.body.textContent).toContain("Metadata JSON encoding");

    const payloadDetails = document.body.querySelector<HTMLDetailsElement>(
      '[data-testid="hizofs-binary-payload-details"]',
    );
    if (payloadDetails === null) throw new Error("Binary payload details were missing");
    payloadDetails.open = true;
    payloadDetails.dispatchEvent(new Event("toggle"));
    await flushPromises();
    expect(document.body.textContent).toContain("de ad be ef");
    expect(document.body.textContent).not.toContain("nonceBytes");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-root-from-object"]',
      )
      ?.click();
    await flushPromises();
    expect(client.readNode).toHaveBeenCalledWith({
      commitObjectId: "object-a",
      nodeId: "root-a",
      logicalPath: "/",
      maximumDirectoryEntryCount: 10_000,
    });

    wrapper.unmount();
  });

  it("keeps actual metadata JSON visible when DTO validation fails", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    const invalidMetadata = {
      revision: "not-a-number",
      unknownPersistedField: "must remain visible",
    };
    const original = await client.inspectObject({
      objectId: "object-a",
      binaryPreviewByteLength: 1024,
    });
    if (original === undefined) throw new Error("Object fixture was missing");
    vi.mocked(client.inspectObject).mockResolvedValue({
      ...original,
      object: {
        ...original.object,
        binary: createBinaryRecordInspection({
          recordKindId: 1,
          recordKind: "commit",
          metadata: invalidMetadata,
          binaryPayload: new Uint8Array(),
        }),
        record: {
          ...original.object.record,
          metadata: invalidMetadata,
          binaryPayloadByteLength: 0,
        },
      },
      validation: {
        status: "invalid",
        errorMessage: "Expected number, received string",
      },
      references: [],
      rootDirectoryEntryPoint: undefined,
    });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-object-store"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-object-entry"]',
      )
      ?.click();
    await flushPromises();

    expect(document.body.textContent).toContain(
      '"unknownPersistedField": "must remain visible"',
    );
    expect(document.body.textContent).toContain("Validation · derived");
    expect(document.body.textContent).toContain(
      "Expected number, received string",
    );

    wrapper.unmount();
  });

  it("switches from persisted inspection to the isolated benchmark panel", async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="hizofs-benchmark-panel"]')).toBeNull();
    document.body
      .querySelector<HTMLButtonElement>('[data-testid="hizofs-primary-benchmark"]')
      ?.click();
    await flushPromises();

    expect(document.body.querySelector('[data-testid="hizofs-benchmark-panel"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="hizofs-companion-explorer"]')).toBeNull();

    wrapper.unmount();
  });

  it("opens the active root as a shallow persisted-navigation entry point and follows directory entries", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-root-directory"]',
      )
      ?.click();
    await flushPromises();

    expect(client.readNode).toHaveBeenCalledWith({
      commitObjectId: "commit-a",
      nodeId: "root-a",
      logicalPath: "/",
      maximumDirectoryEntryCount: 10_000,
    });
    expect(document.body.textContent).toContain("Resolved navigation shortcut");
    expect(document.body.textContent).toContain("Persisted reference chain");
    expect(document.body.textContent).toContain("commit.rootDirectoryNodeId");
    expect(document.body.textContent).toContain("inodeIndexRootObjectId");
    expect(document.body.textContent).toContain("Persisted directory entries · inline");
    expect(document.body.textContent).toContain("docs-node");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-child-node"]',
      )
      ?.click();
    await flushPromises();
    expect(client.readNode).toHaveBeenLastCalledWith({
      commitObjectId: "commit-a",
      nodeId: "docs-node",
      logicalPath: "/docs",
      maximumDirectoryEntryCount: 10_000,
    });

    wrapper.unmount();
  });

  it("lazily opens a decrypted companion Explorer, follows low-level traversal, and can reopen records from a selected entry", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="embedded-file-explorer"]')).toBeNull();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-toggle-companion-explorer"]',
      )
      ?.click();
    await flushPromises();

    let companion = document.body.querySelector<HTMLElement>(
      '[data-testid="embedded-file-explorer"]',
    );
    if (companion === null) throw new Error("Companion File Explorer did not mount lazily");
    expect(companion.textContent).toContain("visible:load::Inspect HizoFS records");
    expect(document.body.querySelector('[data-testid="hizofs-companion-files-icon"]')).not.toBeNull();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-root-directory"]',
      )
      ?.click();
    await flushPromises();
    companion = document.body.querySelector<HTMLElement>(
      '[data-testid="embedded-file-explorer"]',
    );
    expect(companion?.textContent).toContain("true:visible:load:/:Inspect HizoFS records");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-child-node"]',
      )
      ?.click();
    await flushPromises();
    companion = document.body.querySelector<HTMLElement>(
      '[data-testid="embedded-file-explorer"]',
    );
    expect(companion?.textContent).toContain("true:visible:load:/docs:Inspect HizoFS records");

    vi.mocked(client.readPath).mockClear();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="mock-inspect-hizofs-records"]',
      )
      ?.click();
    await flushPromises();

    expect(client.readPath).toHaveBeenCalledWith({
      commitObjectId: "commit-a",
      logicalPath: "/docs",
      maximumDirectoryEntryCount: 1_000,
    });
    expect(document.body.textContent).toContain("Raw DTO · exact inode metadata");
    expect(document.body.textContent).toContain("Persisted reference chain · continue traversal");

    wrapper.unmount();
  });

  it("creates an ephemeral workspace without requiring an active encrypted Naidan store", async () => {
    mocks.listSources.mockResolvedValue([]);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.textContent).toContain(
      "Create an ephemeral workspace",
    );
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-create-workspace"]',
      )
      ?.click();
    await flushPromises();

    expect(mocks.createWorkspace).toHaveBeenCalledOnce();
    expect(mocks.listSources).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("generates a comprehensive fixture only for an ephemeral workspace and follows its root", async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="hizofs-open-comprehensive-fixture"]')).toBeNull();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-source-id="debug-workspace:workspace-a"]',
      )
      ?.click();
    await flushPromises();

    const openButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="hizofs-open-comprehensive-fixture"]',
    );
    expect(openButton?.textContent).toContain("Generate comprehensive fixture…");
    openButton?.click();
    await flushPromises();
    expect(document.body.textContent).toContain("extent files");
    expect(document.body.textContent).toContain("Copy-on-Write history");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-generate-comprehensive-fixture"]',
      )
      ?.click();
    await flushPromises();

    expect(mocks.generateFixture).toHaveBeenCalledWith({
      root: expect.objectContaining({ kind: "directory" }),
      onProgress: expect.any(Function),
    });
    expect(document.body.textContent).toContain("Generated 1 coverage cases");
    expect(document.body.querySelector('[data-testid="embedded-file-explorer"]')).not.toBeNull();

    const latestClient = vi.mocked(mocks.createClient).mock.results.at(-1)?.value;
    expect(latestClient).toBeDefined();
    const client = await latestClient;
    expect(client.readPath).toHaveBeenCalledWith({
      commitObjectId: "commit-a",
      logicalPath: "/__hizofs_fixture__",
      maximumDirectoryEntryCount: 1_000,
    });

    wrapper.unmount();
  });

  it("reinitializes the lazy companion Explorer only after a different source is expanded", async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-toggle-companion-explorer"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="embedded-file-explorer"]')).not.toBeNull();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-source-id="debug-workspace:workspace-a"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="embedded-file-explorer"]')).toBeNull();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-toggle-companion-explorer"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="embedded-file-explorer"]')?.textContent)
      .toContain('false:visible:load::Inspect HizoFS records');

    wrapper.unmount();
  });

  it("runs integrity scanning in the worker and releases the worker and source session", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    const session = createSourceSession({
      source: activeSource,
      fileSystemId: "filesystem-a",
    });
    mocks.createClient.mockResolvedValue(client);
    mocks.openSource.mockResolvedValue(session);
    const wrapper = mount(HizoFSWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-open-integrity"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="hizofs-run-integrity"]',
      )
      ?.click();
    await flushPromises();
    expect(client.runIntegrityScan).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("orphan-a");

    wrapper.unmount();
    await flushPromises();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
