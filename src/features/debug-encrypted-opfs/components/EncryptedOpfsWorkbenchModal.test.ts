import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EncryptedOpfsInspectionWorkerClient } from "@/features/debug-encrypted-opfs/worker/types";
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
        value: {
          sequence: 4,
          fileSystemId,
          activeCommitObjectId: "commit-a",
        },
        persistedDto: {
          sequence: 4,
          fileSystemId,
          activeCommitObjectId: "commit-a",
        },
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
    activeCommit: {
      revision: 5,
      rootDirectoryNodeId: "root-a",
      inodeIndexRootObjectId: "inode-index-a",
    },
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
      envelope: {
        formatVersion: 1,
        nonceBytes: new Array<number>(12).fill(1),
        ciphertextByteLength: 32,
      },
      record: {
        kind: "commit",
        recordVersion: 1,
        metadata: {
          revision: 5,
          rootDirectoryNodeId: "root-a",
          inodeIndexRootObjectId: "inode-index-a",
        },
        binaryPayloadByteLength: 0,
        binaryPayloadPreviewBytes: [],
        binaryPayloadPreviewTruncated: false,
      },
    },
    validation: {
      status: "valid",
      persistedDto: {
        revision: 5,
        rootDirectoryNodeId: "root-a",
        inodeIndexRootObjectId: "inode-index-a",
      },
    },
    references: [{ relation: "inode index root", objectId: "inode-index-a" }],
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

  it("inspects exact record DTOs and keeps parsed binary headers visibly separate", async () => {
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
      binaryPayloadPreviewByteLength: 512,
    });
    expect(document.body.textContent).toContain(
      "Raw DTO · exact record metadata",
    );
    expect(document.body.textContent).toContain('"revision": 5');
    expect(document.body.textContent).toContain("Parsed binary header");
    expect(document.body.textContent).toContain("this is not a DTO");

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
