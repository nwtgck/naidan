import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EncryptedOpfsBinaryRecordInspectionView,
  EncryptedOpfsInspectionWorkerClient,
  EncryptedOpfsResolvedNodeView,
} from "@/features/debug-encrypted-opfs/worker/types";
import type {
  EncryptedOpfsWorkbenchSource,
  EncryptedOpfsWorkbenchSourceSession,
} from "@/features/debug-encrypted-opfs/logic/workbench-sources";
import EncryptedOpfsWorkbenchModal from "./EncryptedOpfsWorkbenchModal.vue";

type OverviewResult = Awaited<
  ReturnType<EncryptedOpfsInspectionWorkerClient["readOverview"]>
>;
type InspectedObjectResult = Awaited<
  ReturnType<EncryptedOpfsInspectionWorkerClient["inspectObject"]>
>;
type NamespaceResult = Awaited<
  ReturnType<EncryptedOpfsInspectionWorkerClient["readNamespace"]>
>;
type IntegrityResult = Awaited<
  ReturnType<EncryptedOpfsInspectionWorkerClient["runIntegrityScan"]>
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
}): EncryptedOpfsBinaryRecordInspectionView {
  const metadataText = JSON.stringify(metadata);
  const metadataBytes = new TextEncoder().encode(metadataText);
  const persistedBytes = new Uint8Array(64);
  persistedBytes.set([0x45, 0x4e, 0x43, 0x4f, 0x50, 0x46, 0x53, 0x00], 0);
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
          interpretation: '"ENCOPFS\\0"',
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

const mocks = vi.hoisted(() => ({
  closeWorkbench: vi.fn(),
  createClient: vi.fn(),
  createWorkspace: vi.fn(),
  destroyWorkspace: vi.fn(),
  listSources: vi.fn(),
  openControlPlane: vi.fn(),
  openFileExplorer: vi.fn(),
  openSource: vi.fn(),
}));

vi.mock(
  "@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsWorkbench",
  () => ({
    useDebugEncryptedOpfsWorkbench: () => ({
      closeDebugEncryptedOpfsWorkbench: mocks.closeWorkbench,
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

vi.mock("@/features/debug-encrypted-opfs/logic/workbench-sources", () => ({
  listEncryptedOpfsWorkbenchSources: mocks.listSources,
  createEncryptedOpfsWorkbenchWorkspace: mocks.createWorkspace,
  destroyEncryptedOpfsWorkbenchWorkspace: mocks.destroyWorkspace,
  openEncryptedOpfsWorkbenchSource: mocks.openSource,
}));

vi.mock("@/features/debug-encrypted-opfs/worker/client", () => ({
  createEncryptedOpfsInspectionWorkerClient: mocks.createClient,
}));

vi.mock("@/features/file-explorer/composables/useFileExplorerModal", () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock("@/features/file-explorer/components/FileExplorer.vue", () => ({
  default: {
    props: ["root", "initialLocked"],
    template:
      '<div data-testid="embedded-file-explorer">{{ root.kind }}:{{ root.rootName }}:{{ String(initialLocked) }}</div>',
  },
}));

vi.mock("@/features/json-viewer", () => ({
  JsonCodeView: {
    props: ["source"],
    template: '<pre data-testid="json-code-view">{{ source }}</pre>',
  },
}));

const activeSource: Extract<
  EncryptedOpfsWorkbenchSource,
  { readonly type: "naidan_active_store" }
> = {
  type: "naidan_active_store",
  sourceId: "naidan-active-store",
  label: "Naidan active encrypted store",
  access: "read_only",
  encryptedStoreId: "store-a",
};

const workspaceSource: Extract<
  EncryptedOpfsWorkbenchSource,
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
    physicalPath: ["naidan-debug-encrypted-opfs", "runtime-workspace-a"],
  },
};

function createSourceSession({
  source,
  fileSystemId,
}: {
  source: EncryptedOpfsWorkbenchSourceSession["source"];
  fileSystemId: string;
}): EncryptedOpfsWorkbenchSourceSession {
  return {
    source,
    fileSystemId,
    physicalPath: ["naidan-storage", "encrypted-stores", "store-a", "data"],
    decryptedRoot: {
      kind: "directory",
      name: "",
    } as EncryptedOpfsWorkbenchSourceSession["decryptedRoot"],
    encryptedOpfsReader:
      {} as EncryptedOpfsWorkbenchSourceSession["encryptedOpfsReader"],
    dispose: vi.fn(async () => {}),
  };
}

function createClient({
  fileSystemId,
}: {
  fileSystemId: string;
}): EncryptedOpfsInspectionWorkerClient {
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
  const overview: OverviewResult = {
    descriptor: { formatVersion: 1, fileSystemId },
    persistedDescriptorDto: {
      formatVersion: 1,
      fileSystemId,
      unknownPersistedField: "must remain visible",
    },
    superblockSlots: [
      {
        slot: 0,
        status: "valid",
        selected: true,
        physicalPath: ["superblock-0.eopfs"],
        value: superblockMetadata,
        persistedDto: superblockMetadata,
        binary: createBinaryRecordInspection({
          recordKindId: 9,
          recordKind: "superblock",
          metadata: superblockMetadata,
          binaryPayload: new Uint8Array(),
        }),
      },
      {
        slot: 1,
        status: "missing",
        selected: false,
        physicalPath: ["superblock-1.eopfs"],
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
      physicalPath: ["objects", "00", "object-a.eopfs"],
      physicalByteLength: 64,
      binary: createBinaryRecordInspection({
        recordKindId: 1,
        recordKind: "commit",
        metadata: commitMetadata,
        binaryPayload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
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
  const resolvedRoot: EncryptedOpfsResolvedNodeView = {
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
  const resolvedDocs: EncryptedOpfsResolvedNodeView = {
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
          physicalPath: ["objects", "00", "object-a.eopfs"],
        },
      ],
      nextCursor: undefined,
      ignoredPhysicalPaths: [],
    })),
    inspectObject: vi.fn(async () => inspectedObject),
    readNode: vi.fn(async ({ nodeId }) => nodeId === "root-a" ? resolvedRoot : resolvedDocs),
    readNamespace: vi.fn(async () => namespace),
    runIntegrityScan: vi.fn(async () => integrity),
    cancelCurrentOperation: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

describe("EncryptedOpfsWorkbenchModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSources.mockResolvedValue([activeSource, workspaceSource]);
    mocks.openSource.mockImplementation(
      async ({
        source,
      }: {
        source: EncryptedOpfsWorkbenchSourceSession["source"];
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
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts from the EncryptedOpfs source and exposes low-level persisted records before derived views", async () => {
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.textContent).toContain("EncryptedOpfs Workbench");
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

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-descriptor"]',
      )
      ?.click();
    await flushPromises();
    expect(document.body.textContent).toContain(
      "Raw DTO · exact persisted representation",
    );
    expect(document.body.textContent).toContain(
      '"fileSystemId": "filesystem-a"',
    );
    expect(document.body.textContent).toContain(
      '"unknownPersistedField": "must remain visible"',
    );

    wrapper.unmount();
  });

  it("marks File Explorer as derived and passes the decrypted EncryptedOpfs root directly", async () => {
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-derived-views"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-derived-file-explorer"]',
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
        '[data-testid="encrypted-opfs-source"]',
      ),
    ).find((button) => button.dataset.sourceId === workspaceSource.sourceId);
    if (workspaceButton === undefined)
      throw new Error("Ephemeral source button was not rendered");
    workspaceButton.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-derived-views"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-derived-file-explorer"]',
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

  it("renders persisted and decrypted binary as hex while limiting Raw DTO to metadata JSON", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-object-store"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-object-entry"]',
      )
      ?.click();
    await flushPromises();

    expect(client.inspectObject).toHaveBeenCalledWith({
      objectId: "object-a",
      binaryPreviewByteLength: 1024,
    });
    expect(document.body.textContent).toContain("Persisted object bytes");
    expect(document.body.textContent).toContain("45 4e 43 4f 50 46 53 00");
    expect(document.body.textContent).toContain("Decoded object envelope fields");
    expect(document.body.textContent).toContain("Decrypted record bytes");
    expect(document.body.textContent).toContain("Decoded record header fields");
    expect(document.body.textContent).toContain("Metadata JSON bytes");
    expect(document.body.textContent).toContain(
      "Raw DTO · parsed only from the actual metadata JSON range",
    );
    expect(document.body.textContent).toContain('"revision": 5');
    expect(document.body.textContent).toContain("Binary payload bytes");
    expect(document.body.textContent).toContain("de ad be ef");
    expect(document.body.textContent).not.toContain("nonceBytes");

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-root-from-object"]',
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
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-object-store"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-object-entry"]',
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

  it("opens the active root as a shallow persisted-navigation entry point and follows directory entries", async () => {
    const client = createClient({ fileSystemId: "filesystem-a" });
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-root-directory"]',
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
        '[data-testid="encrypted-opfs-open-child-node"]',
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

  it("creates an ephemeral workspace without requiring an active encrypted Naidan store", async () => {
    mocks.listSources.mockResolvedValue([]);
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.textContent).toContain(
      "Create an ephemeral workspace",
    );
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-create-workspace"]',
      )
      ?.click();
    await flushPromises();

    expect(mocks.createWorkspace).toHaveBeenCalledOnce();
    expect(mocks.listSources).toHaveBeenCalledTimes(2);

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
    const wrapper = mount(EncryptedOpfsWorkbenchModal, {
      attachTo: document.body,
    });
    await flushPromises();

    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-open-integrity"]',
      )
      ?.click();
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-testid="encrypted-opfs-run-integrity"]',
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
