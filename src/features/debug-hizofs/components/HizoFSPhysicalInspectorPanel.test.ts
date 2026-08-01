import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HizoFSPhysicalInspectionWorker } from "@/features/debug-hizofs/worker/physical-inspection";
import HizoFSPhysicalInspectorPanel from "./HizoFSPhysicalInspectorPanel.vue";

const mocks = vi.hoisted(() => ({
  createContainerView: vi.fn(),
  createNamespaceView: vi.fn(),
  createRecordView: vi.fn(),
}));

vi.mock("@/features/debug-hizofs/logic/physical-container-inspection-view", () => ({
  createHizoFSPhysicalContainerInspectionView: mocks.createContainerView,
}));

vi.mock("@/features/debug-hizofs/logic/namespace-inspection-view", () => ({
  createHizoFSNamespaceInspectionView: mocks.createNamespaceView,
}));

vi.mock("@/features/debug-hizofs/logic/physical-record-inspection-view", () => ({
  createHizoFSPhysicalRecordInspectionView: mocks.createRecordView,
}));

function createWorker(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
  };
}

describe("HizoFSPhysicalInspectorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createContainerView.mockReturnValue({
      authorityNavigationTargets: [{
        label: "Relocation Index",
        request: {
          frameLength: 176,
          pageIsRoot: true,
          physicalOffset: "640",
          physicalSegmentId: "00000000000000000000000000000041",
          recordKind: 48,
        },
      }],
      copyRows: [{
        activeCommit: {
          byteOffset: "64",
          frameLength: 128,
          recordKind: 3,
          segmentId: "00000000000000000000000000000001",
        },
        activeCommitSequence: "4",
        copy: 0,
        header: undefined,
        headerJson: '{"copy":0,"nonce":{"byteLength":12,"hex":"0102"}}',
        kind: "superblock",
        minimumUnlockSequence: "9",
        path: "superblock-0",
        plaintext: undefined,
        plaintextJson: '{"requiredFeatureBits":"5"}',
        publicationSequence: "12",
        reason: undefined,
        relocationIndexRoot: {
          byteOffset: "640",
          frameLength: 176,
          recordKind: 48,
          segmentId: "00000000000000000000000000000041",
        },
        requiredFeatureBits: "5",
        selected: true,
        state: "proof_valid",
      }],
      displayedFrameCount: 1,
      frameRowsTruncated: false,
      physicalAnomalies: ["unknown physical entry"],
      rootDirectorySummary: "read_write, commit 4, root inode 1",
      rootNavigationTargets: [{
        label: "Active Commit",
        request: {
          frameLength: 128,
          homeOffset: "64",
          homeSegmentId: "00000000000000000000000000000001",
          recordKind: 3,
        },
      }],
      segmentRows: [{ fileSize: "1024", frameCount: 1, frameRowsTruncated: false, frames: [{ frameLength: 128, homeOffset: "64", homeSegmentId: "00000000000000000000000000000001", physicalOffset: "96", physicalSegmentId: "00000000000000000000000000000002", plaintextLength: 48, recordKind: 3 }], path: "segments/a", physicalSegmentId: "00000000000000000000000000000002", reason: undefined, segmentClass: "metadata", state: "sealed" }],
      superblockSelectionSummary: "copy 0, sequence 12, converged",
      totalFrameCount: 1,
      unlockSelectionSummary: "copy 1, sequence 9, degraded",
    });
    mocks.createRecordView.mockReturnValue({
      frameLength: 128,
      headerFlags: 3,
      homeOffset: "64",
      homeSegmentId: "01",
      identitySummary: "home 01:64; physical 02:96",
      navigationTargets: [],
      payload: { byteLength: 48, kind: "file_data", state: "decoded" },
      payloadDocumentLabel: "Bounded File Data inspection",
      payloadJson: JSON.stringify({ byteLength: 48, kind: "file_data", state: "decoded" }, undefined, 2),
      payloadSummary: "file data, 48 bytes",
      physicalOffset: "96",
      physicalSegmentId: "02",
      plaintextByteLength: 48,
      plaintextPreviewBase64Url: "cGF5bG9hZA",
      plaintextPreviewByteLength: 48,
      plaintextPreviewTruncated: false,
      plaintextSummary: "48/48 bytes previewed",
      recordKind: 2,
      recordKindName: "file_data",
      sealedLength: 64,
    });
    mocks.createNamespaceView.mockReturnValue({
      authoritySummary: "active, Commit 4",
      commitSequence: "4",
      createdAt: "100",
      directoryEntries: [{
        kind: "file",
        name: "notes.txt",
        path: "/docs/notes.txt",
        pathComponents: ["docs", "notes.txt"],
        target: "inode 7",
      }],
      directorySummary: "1 entries",
      fileSize: undefined,
      inodeKind: "directory",
      inodeNumber: "1",
      inodeRevision: "3",
      inodeSummary: "directory inode 1, revision 3",
      modifiedAt: "120",
      pageNavigationSummary: "1 page references",
      pageNavigationTargets: [{
        label: "Inode Table page 1",
        request: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "00000000000000000000000000000003",
          pageIsRoot: true,
          recordKind: 5,
        },
        role: "inode_table",
      }],
      pageReadsTruncated: false,
      pagesRead: 3,
      parentPath: "/",
      parentPathComponents: [],
      path: "/docs",
      pathComponents: ["docs"],
      resourceSummary: "3 authenticated pages read",
      symlinkTarget: undefined,
    });
  });

  it("reads physical state without retaining the submitted passphrase", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("correct horse");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectContainer).toHaveBeenCalledWith({ passphrase: "correct horse" });
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-container"]').text()).toContain("copy 0, sequence 12");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-container"]').text()).toContain("unknown physical entry");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-copy-details"]').text()).toContain("active Commit sequence 4");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-copy-details"]').text()).toContain("required feature bits 5");
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-persisted-dto"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-copy-details"]').text()).toContain("Exact Superblock Header DTO");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-copy-details"]').text()).toContain('"requiredFeatureBits":"5"');
  });

  it("opens the selected Superblock relocation root as a physical-only root page", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("relocation passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-authority-navigation"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "relocation passphrase",
      request: {
        frameLength: 176,
        pageIsRoot: true,
        physicalOffset: "640",
        physicalSegmentId: "00000000000000000000000000000041",
        recordKind: 48,
      },
    });
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("opens an authoritative Root shortcut reference without selecting a physical frame", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("record passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-root-navigation"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "record passphrase",
      request: {
        frameLength: 128,
        homeOffset: "64",
        homeSegmentId: "00000000000000000000000000000001",
        recordKind: 3,
      },
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record"]').text()).toContain("file data, 48 bytes");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-fields"]').text()).toContain("Header flags3");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-payload"]').text()).toContain('"byteLength": 48');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-selection"]').exists()).toBe(false);
  });

  it("inspects a selected physical frame with an explicit page role", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-page-role"]').setValue("root");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-record"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "container passphrase",
      request: {
        frameLength: 128,
        homeOffset: "64",
        homeSegmentId: "00000000000000000000000000000001",
        pageIsRoot: true,
        physicalOffset: "96",
        physicalSegmentId: "00000000000000000000000000000002",
        recordKind: 3,
      },
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record"]').text()).toContain("file data, 48 bytes");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("follows an authoritative Commit home reference with a new one-shot passphrase", async () => {
    const inspector = createWorker();
    mocks.createRecordView
      .mockReturnValueOnce({
        identitySummary: "home 01:64; physical 02:96",
        navigationTargets: [{
          label: "Root Inode Table",
          targetType: "home_record",
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "00000000000000000000000000000003",
            pageIsRoot: true,
            recordKind: 5,
          },
        }],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadSummary: "Commit 4, root inode 1",
        plaintextSummary: "48/48 bytes previewed",
        recordKindName: "file_system_commit",
      })
      .mockReturnValueOnce({
        identitySummary: "home 03:128; physical 04:192",
        navigationTargets: [],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadSummary: "inode_table leaf, level 0, 1 items, root",
        plaintextSummary: "96/96 bytes previewed",
        recordKindName: "inode_table_page",
      });
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("first passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("second passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-record"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("third passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-home-record"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "third passphrase",
      request: {
        frameLength: 160,
        homeOffset: "128",
        homeSegmentId: "00000000000000000000000000000003",
        pageIsRoot: true,
        recordKind: 5,
      },
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record"]').text()).toContain("inode_table leaf");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("follows a physical-only relocation child without inventing a home reference", async () => {
    const inspector = createWorker();
    mocks.createRecordView
      .mockReturnValueOnce({
        identitySummary: "home 01:64; physical 02:96",
        navigationTargets: [{
          label: "Relocation child page 1",
          request: {
            frameLength: 176,
            pageIsRoot: false,
            physicalOffset: "640",
            physicalSegmentId: "00000000000000000000000000000041",
            recordKind: 48,
          },
          targetType: "physical_record",
        }],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadSummary: "relocation_index branch, level 1, 1 items, root",
        plaintextSummary: "48/48 bytes previewed",
        recordKindName: "relocation_index_page",
      })
      .mockReturnValueOnce({
        identitySummary: "home 41:640; physical 41:640",
        navigationTargets: [],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadSummary: "relocation_index leaf, level 0, 0 items, non-root",
        plaintextSummary: "16/16 bytes previewed",
        recordKindName: "relocation_index_page",
      });
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("first passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("second passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-record"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("third passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-physical-record"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectRecord).toHaveBeenLastCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "third passphrase",
      request: {
        frameLength: 176,
        pageIsRoot: false,
        physicalOffset: "640",
        physicalSegmentId: "00000000000000000000000000000041",
        recordKind: 48,
      },
    });
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("rejects ambiguous UI paths before I/O and forwards exact valid components", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("first passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-path"]').setValue("/docs//notes.txt/");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectNamespacePath).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-error"]').text())
      .toContain("filename component");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value)
      .toBe("");

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("second passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-path"]').setValue("/docs/notes.txt");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      passphrase: "second passphrase",
      pathComponents: ["docs", "notes.txt"],
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace"]').text()).toContain("/docs");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace-row"]').text()).toContain("notes.txt");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-inode-fields"]').text()).toContain("Created at100");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-inode-fields"]').text()).toContain("Modified at120");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace-page"]').text()).toContain("inode_table");
  });

  it("opens an authenticated namespace page reference with a new one-shot passphrase", async () => {
    mocks.createRecordView.mockReturnValueOnce({
      identitySummary: "home 03:128; physical 03:128",
      navigationTargets: [],
      payloadSummary: "inode_table leaf, level 0, 1 items, root",
      plaintextSummary: "80/80 bytes previewed",
      recordKindName: "inode_table_page",
    });
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("namespace passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("page passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-namespace-page"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "page passphrase",
      request: {
        frameLength: 160,
        homeOffset: "128",
        homeSegmentId: "00000000000000000000000000000003",
        pageIsRoot: true,
        recordKind: 5,
      },
    });
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record"]').text()).toContain("inode_table leaf");
  });

  it("selects child and parent namespace paths without retaining a credential", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("one-shot");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    const pathInput = wrapper.get('[data-testid="hizofs-physical-inspector-path"]');
    await wrapper.get('[data-testid="hizofs-physical-inspector-namespace-entry"]').trigger("click");
    expect((pathInput.element as HTMLInputElement).value).toBe("/docs/notes.txt");
    expect(inspector.inspectNamespacePath).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-testid="hizofs-physical-inspector-parent-path"]').trigger("click");
    expect((pathInput.element as HTMLInputElement).value).toBe("/");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("does not retain a stale physical view after a refresh failure", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("first");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-container"]').exists()).toBe(true);

    vi.mocked(inspector.inspectContainer).mockRejectedValueOnce(new Error("refresh failed"));
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("second");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-container"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-error"]').text()).toContain("refresh failed");
  });

  it("does not retain a stale namespace record after a refresh failure", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("namespace");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("record");
    await wrapper.get('[data-testid="hizofs-physical-inspector-namespace-page"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record"]').exists()).toBe(true);

    vi.mocked(inspector.inspectNamespacePath).mockRejectedValueOnce(new Error("namespace refresh failed"));
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("refresh");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-namespace"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-error"]').text()).toContain("namespace refresh failed");

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("retry");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-namespace"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record"]').exists()).toBe(false);
  });

  it("clears the passphrase and surfaces a one-shot inspection failure", async () => {
    const inspector = createWorker();
    vi.mocked(inspector.inspectContainer).mockRejectedValueOnce(new Error("authentication failed"));
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("wrong");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="hizofs-physical-inspector-error"]').text()).toContain("authentication failed");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("renders as the embedded Physical Inspector panel without a nested portable modal", () => {
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector: createWorker() } });

    expect(wrapper.text()).toContain("Physical Inspector");
    expect(wrapper.text()).not.toContain("Portable HizoFS Inspector");
    expect(wrapper.attributes("aria-modal")).toBeUndefined();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-close"]').exists()).toBe(false);
  });
});
