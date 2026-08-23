import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HizoFSAuthenticatedInspectionSession } from "@/features/debug-hizofs/worker/authenticated-inspection-session";
import type { HizoFSPhysicalInspectionWorker } from "@/features/debug-hizofs/worker/physical-inspection";
import HizoFSPhysicalInspectorPanel from "./HizoFSPhysicalInspectorPanel.vue";

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
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

vi.mock("@/features/file-explorer/components/FileExplorer.vue", () => ({
  default: {
    name: "FileExplorer",
    props: [
      "root",
      "initialPath",
      "initialLocked",
      "initialViewMode",
      "initialPreviewVisibility",
      "revealPath",
      "revealFilePreview",
      "entryContextActionLabel",
    ],
    template: '<div data-testid="mock-hizofs-file-explorer">{{ revealPath }}</div>',
  },
}));


function createAuthenticatedSession(): HizoFSAuthenticatedInspectionSession {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async request => request as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({
      frameBase64Url: "AQIDBA",
      frameByteLength: 4,
      physicalOffset: "128",
      physicalSegmentId: "00000000000000000000000000000002",
    })),
  };
}

function createWorker(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async request => request as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({
      frameBase64Url: "AQIDBA",
      frameByteLength: 4,
      physicalOffset: "128",
      physicalSegmentId: "00000000000000000000000000000002",
    })),
  };
}

describe("HizoFSPhysicalInspectorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.clipboardWriteText },
    });
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
        fallbackCommit: {
          byteOffset: "32",
          frameLength: 128,
          recordKind: 3,
          segmentId: "00000000000000000000000000000009",
        },
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
      recoveryNavigationTargets: [{
        label: "Fallback Commit candidate",
        request: {
          frameLength: 128,
          homeOffset: "32",
          homeSegmentId: "00000000000000000000000000000009",
          recordKind: 3,
        },
      }],
      rootDirectorySummary: "fallback_read_only, commit 4, root inode 1",
      rootRecoveryReason: "active Commit authentication failed",
      rootNavigationTargets: [{
        label: "Fallback Commit",
        request: {
          frameLength: 128,
          homeOffset: "64",
          homeSegmentId: "00000000000000000000000000000001",
          recordKind: 3,
        },
      }],
      segmentRows: [{
        fileSize: "1024",
        footerHeader: {},
        footerHeaderJson: '{"entryCount":1}',
        footerIndexEntries: [{ recordKind: 3 }],
        footerIndexEntriesJson: '[{"recordKind":3}]',
        footerPhysicalOffset: "768",
        footerTotalLength: 256,
        footerTrailer: {},
        footerTrailerJson: '{"footerTotalLength":256}',
        frameCount: 1,
        frameRowsTruncated: false,
        frames: [{
          flags: 0,
          frameLength: 128,
          header: {},
          headerJson: '{"recordKind":3,"recordCodecVersion":1}',
          homeOffset: "64",
          homeReference: { byteOffset: "64", frameLength: 128, recordKind: 3, segmentId: "00000000000000000000000000000001" },
          homeSegmentId: "00000000000000000000000000000001",
          physicalOffset: "96",
          physicalSegmentId: "00000000000000000000000000000002",
          plaintextLength: 48,
          recordKind: 3,
        }],
        header: {},
        headerJson: '{"segmentClass":"metadata"}',
        path: "segments/a",
        physicalSegmentId: "00000000000000000000000000000002",
        reason: undefined,
        segmentClass: "metadata",
        state: "sealed",
      }],
      superblockSelectionSummary: "copy 0, sequence 12, converged",
      totalFrameCount: 1,
      unlockSelectionSummary: "copy 1, sequence 9, degraded",
    });
    mocks.createRecordView.mockReturnValue({
      frameLength: 128,
      header: {},
      headerFlags: 3,
      headerJson: '{"recordKind":2,"recordCodecVersion":1}',
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
    mocks.createNamespaceView.mockImplementation(({ inspection }: {
      inspection: { readonly pathComponents?: readonly string[] };
    }) => {
      const pathComponents = inspection.pathComponents ?? [];
      const path = pathComponents.length === 0 ? "/" : `/${pathComponents.join("/")}`;
      const child = pathComponents.length === 0
        ? { kind: "directory", name: "docs", path: "/docs", pathComponents: ["docs"], target: "inode 1" }
        : pathComponents.length === 1
          ? { kind: "file", name: "notes.txt", path: "/docs/notes.txt", pathComponents: ["docs", "notes.txt"], target: "inode 7" }
          : undefined;
      return {
        authorityMode: "active",
        authoritySummary: "active, Commit 4",
        commitSequence: "4",
        createdAt: "100",
        directoryEntries: child === undefined ? [] : [child],
        directorySummary: child === undefined ? undefined : "1 entries",
        fileSize: child === undefined ? "12" : undefined,
        inodeKind: child === undefined ? "file" : "directory",
        inodeNumber: child === undefined ? "7" : "1",
        inodeRevision: "3",
        inodeSummary: `${child === undefined ? "file" : "directory"} inode ${child === undefined ? "7" : "1"}, revision 3`,
        modifiedAt: "120",
        parentPath: pathComponents.length === 0
          ? undefined
          : pathComponents.length === 1 ? "/" : `/${pathComponents.slice(0, -1).join("/")}`,
        parentPathComponents: pathComponents.length === 0 ? undefined : pathComponents.slice(0, -1),
        path,
        pathComponents,
        symlinkTarget: undefined,
        validationEvidence: {
          rawPageReadEvents: [1, 2, 3].map(index => ({
            label: `Page-read event ${String(index)}`,
            request: {
              frameLength: 160,
              homeOffset: "128",
              homeSegmentId: "00000000000000000000000000000003",
              pageIsRoot: true,
              recordKind: 5,
            },
            role: "inode_table" as const,
          })),
          recordedPageReadEventCount: 3,
          repeatedPageReadEventCount: 2,
          totalPageReadEventCount: 3,
          traceTruncated: false,
          uniqueHomeRecordReferences: [{
            occurrenceCount: 3,
            request: {
              frameLength: 160,
              homeOffset: "128",
              homeSegmentId: "00000000000000000000000000000003",
              pageIsRoot: true,
              recordKind: 5,
            },
            roles: ["inode_table"],
          }],
        },
      };
    });
  });

  it("uses an authenticated source session without exposing a passphrase input", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').text()).toContain("Read physical state");
    expect(wrapper.get('[data-workbench-inspector-surface="physical-authority"]').text()).toContain("Persisted structure");
    expect(wrapper.get('[data-workbench-inspector-surface="physical-authority"]').text()).toContain("Not loaded");
    expect(wrapper.text()).toContain("already supplies authenticated read-only inspection authority");

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();

    expect(authenticatedSession.inspectContainer).toHaveBeenCalledOnce();
    expect(wrapper.findAll('[data-workbench-inspector-surface="physical-authority"]')).toHaveLength(1);
    expect(wrapper.get('[data-workbench-inspector-surface="physical-authority"]').text()).toContain("Persisted structure");
    expect(wrapper.get('[data-workbench-inspector-surface="physical-authority"]').text()).toContain("Loaded · authenticated physical observation");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').text()).toContain("Refresh physical state");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-container"]').text()).toContain("Authority copies");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-container"]').text()).toContain("Segments / frames");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-segment-structure"]').text()).toContain("Persisted Segment structure");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-segment-header"]').text()).toContain("Exact Segment Header DTO");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-segment-footer"]').text()).toContain("Exact authenticated Segment Footer DTOs");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-segment-footer-index"]').text()).toContain('"recordKind":3');
  });

  it("keeps the compatibility credential fallback visually secondary", () => {
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector: createWorker() } });

    const fallback = wrapper.get('[data-testid="hizofs-physical-inspector-credential-fallback"]');
    expect(fallback.attributes("open")).toBeUndefined();
    expect(fallback.text()).toContain("Temporary credential fallback");
    expect(wrapper.text()).toContain("source-owned inspection authority pending");
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
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-authority-column"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-authority-navigation"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-recovery-navigation"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-root-navigation"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-authority-destination"]').text()).toContain("physical 00000000000000000000000000000041:640");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-recovery-destination"]').text()).toContain("home 00000000000000000000000000000009:32");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-root-destination"]').text()).toContain("home 00000000000000000000000000000001:64");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-copy-details"]').text()).toContain("fallback Commit 00000000000000000000000000000009:32");
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

  it("opens the selected Superblock fallback only through an explicit recovery reference", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-container"]').text()).toContain(
      "Authenticated reference stored by the selected Superblock",
    );

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("fallback passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-recovery-navigation"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "fallback passphrase",
      request: {
        frameLength: 128,
        homeOffset: "32",
        homeSegmentId: "00000000000000000000000000000009",
        recordKind: 3,
      },
    });
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
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-plaintext-preview"]').text()).toContain("Authenticated plaintext preview");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-binary-shell"]').text()).toContain("Binary representation");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-binary-shell"]').text()).toContain("Load authenticated framed binary");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-references"]').text()).toContain("Persisted references");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-payload"]').text()).toContain('"byteLength": 48');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-selection"]').exists()).toBe(false);
  });

  it("loads exact framed bytes only on demand through source-owned authenticated authority", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-root-navigation"]').trigger("click");
    await flushPromises();

    expect(authenticatedSession.inspectRecordFrame).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-framed-binary"]').exists()).toBe(false);

    await wrapper.get('[data-testid="hizofs-physical-inspector-load-framed-binary"]').trigger("click");
    await flushPromises();

    expect(authenticatedSession.inspectRecordFrame).toHaveBeenCalledWith({
      request: {
        frameLength: 128,
        homeOffset: "64",
        homeSegmentId: "01",
        physicalOffset: "96",
        physicalSegmentId: "02",
        recordKind: 2,
      },
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-framed-binary"]').text()).toContain("AQIDBA");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-binary-shell"]').text()).toContain("4 bytes");
  });

  it("highlights and copies the exact decoded payload string with accessible feedback", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-root-navigation"]').trigger("click");
    await flushPromises();

    const payloadJson = JSON.stringify({ byteLength: 48, kind: "file_data", state: "decoded" }, undefined, 2);
    const payload = wrapper.get('[data-testid="hizofs-physical-inspector-record-payload"]');
    payload.get("pre.json-code-view");
    expect(payload.findAll(".json-syntax-property").map(token => token.text()))
      .toEqual(expect.arrayContaining(['"byteLength"', '"kind"', '"state"']));
    expect(payload.text()).toBe(payloadJson);

    const copyButton = wrapper.get('[data-testid="hizofs-physical-inspector-copy-record-payload"]');
    expect(copyButton.attributes("aria-label")).toBe("Copy exact decoded payload JSON");
    expect(copyButton.attributes("title")).toBe("Copy exact decoded payload JSON");
    await copyButton.trigger("click");
    await flushPromises();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(payloadJson);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-payload-copy-status"]').text())
      .toBe("Copied");

    mocks.clipboardWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
    await copyButton.trigger("click");
    await flushPromises();
    const failure = wrapper.get('[data-testid="hizofs-physical-inspector-record-payload-copy-status"]');
    expect(failure.text()).toBe("Copy failed");
    expect(failure.attributes("title")).toContain("clipboard denied");
  });

  it("does not surface a framed-binary failure after its record column is closed", async () => {
    let rejectFrame: ((reason?: unknown) => void) | undefined;
    const authenticatedSession = createAuthenticatedSession();
    vi.mocked(authenticatedSession.inspectRecordFrame).mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
      rejectFrame = reject;
    }));
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-root-navigation"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-load-framed-binary"]').trigger("click");
    await Promise.resolve();
    await wrapper.get('[data-testid="hizofs-physical-inspector-close-traversal-column"]').trigger("click");

    rejectFrame?.(new Error("stale frame read failed"));
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-traversal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-error"]').exists()).toBe(false);
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

  it("does not offer a logical Home Record jump for a physical-only frame", async () => {
    const containerView = mocks.createContainerView();
    containerView.segmentRows[0].frames[0].flags = 1;
    containerView.segmentRows[0].frames[0].homeReference = undefined;
    containerView.segmentRows[0].frames[0].recordKind = 48;
    mocks.createContainerView.mockClear();
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-read-home-record"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-read-record"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-selection"]').text()).toContain("record kind48");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record-selection"]').text()).toContain("flags1");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-selected-home-reference"]').text())
      .toBe("unavailable (physical-only frame)");
  });

  it("follows a selected ordinary physical frame back to its authenticated logical Home Record", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-selected-home-reference"]').text())
      .toContain("00000000000000000000000000000001:64, frame 128, kind 3");
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("container passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-home-record"]').trigger("click");
    await flushPromises();

    expect(inspector.inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 4096,
      passphrase: "container passphrase",
      request: {
        frameLength: 128,
        homeOffset: "64",
        homeSegmentId: "00000000000000000000000000000001",
        recordKind: 3,
      },
    });
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-record"]').text()).toContain("file data, 48 bytes");
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
        payloadJson: '{"kind":"file_system_commit"}',
        payloadSummary: "Commit 4, root inode 1",
        plaintextSummary: "48/48 bytes previewed",
        recordKindName: "file_system_commit",
      })
      .mockReturnValueOnce({
        identitySummary: "home 03:128; physical 04:192",
        navigationTargets: [],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadJson: '{"kind":"inode_table_page"}',
        payloadSummary: "inode_table leaf, level 0, 1 items, root",
        plaintextSummary: "96/96 bytes previewed",
        recordKindName: "inode_table_page",
      });
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("first passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-frame"]').trigger("click");
    const columnScroll = wrapper.get('[data-testid="hizofs-physical-inspector-column-scroll"]').element as HTMLElement;
    Object.defineProperty(columnScroll, "scrollWidth", { configurable: true, value: 1200 });
    columnScroll.scrollLeft = 0;
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("second passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-record"]').trigger("click");
    await flushPromises();
    expect(columnScroll.scrollLeft).toBe(1200);

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
    const traversalColumns = wrapper.findAll('[data-testid="hizofs-physical-inspector-traversal-column"]');
    expect(traversalColumns).toHaveLength(2);
    expect(traversalColumns[0]?.text()).toContain("Physical Record");
    expect(traversalColumns[1]?.text()).toContain("Root Inode Table");
    const closeButtons = wrapper.findAll('[data-testid="hizofs-physical-inspector-close-traversal-column"]');
    expect(closeButtons).toHaveLength(2);
    await closeButtons[0]?.trigger("click");
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-traversal-column"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record"]').exists()).toBe(false);
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
        payloadJson: '{"kind":"relocation_index_page"}',
        payloadSummary: "relocation_index branch, level 1, 1 items, root",
        plaintextSummary: "48/48 bytes previewed",
        recordKindName: "relocation_index_page",
      })
      .mockReturnValueOnce({
        identitySummary: "home 41:640; physical 41:640",
        navigationTargets: [],
        payloadDocumentLabel: "Exact decoded structural payload DTO",
        payloadJson: '{"kind":"relocation_index_page"}',
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

    const destination = wrapper.get('[data-testid="hizofs-physical-inspector-reference-destination"]');
    expect(destination.text()).toContain("physical 00000000000000000000000000000041:640");
    expect(destination.text()).toContain("frame 176");
    expect(destination.text()).toContain("kind 48");
    expect(destination.text()).not.toContain("home ");

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
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-namespace-ancestor"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace"]').text()).toContain("/docs/notes.txt");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-inode-fields"]').text()).toContain("Created at100");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-inode-fields"]').text()).toContain("Modified at120");
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-namespace-page"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-validation-summary"]').text()).toContain("Total authenticated page-read events3");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-validation-summary"]').text()).toContain("Unique Home Record References1");
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-validation-summary"]').text()).toContain("Repeated events in recorded trace2");
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-validation-reference"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-validation-event"]')).toHaveLength(3);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-validation-references"]').attributes("open")).toBeUndefined();
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-validation-raw-trace"]').attributes("open")).toBeUndefined();
  });

  it("shows persisted and reference column shells before any authenticated read", () => {
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector: createWorker() } });

    const shell = wrapper.get('[data-testid="hizofs-physical-inspector-empty-columns"]');
    expect(shell.text()).toContain("Persisted structure");
    expect(shell.text()).toContain("Not loaded");
    expect(shell.text()).toContain("Unlock authority");
    expect(shell.text()).toContain("Superblock authority");
    expect(shell.text()).toContain("Logical traversal");
    expect(shell.text()).toContain("No logical path inspected");
  });

  it("accepts a namespace path selected by the Workbench decrypted companion", async () => {
    const wrapper = mount(HizoFSPhysicalInspectorPanel, {
      props: { inspector: createWorker(), requestedNamespacePath: "/docs/notes.txt" },
    });

    expect((wrapper.get('[data-testid="hizofs-physical-inspector-path"]').element as HTMLInputElement).value).toBe("/docs/notes.txt");

    await wrapper.setProps({ requestedNamespacePath: "/archive/report.pdf" });
    await wrapper.vm.$nextTick();
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-path"]').element as HTMLInputElement).value).toBe("/archive/report.pdf");
  });

  it("inspects a Workbench-requested namespace path immediately with source-owned authority", async () => {
    const authenticatedSession = createAuthenticatedSession();
    mount(HizoFSPhysicalInspectorPanel, {
      props: { authenticatedSession, requestedNamespacePath: "/docs/notes.txt" },
    });
    await flushPromises();

    expect(authenticatedSession.inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs", "notes.txt"],
    });
  });

  it("follows the latest Workbench namespace request after an authenticated read already started", async () => {
    let resolveFirst: ((value: never) => void) | undefined;
    const authenticatedSession = createAuthenticatedSession();
    vi.mocked(authenticatedSession.inspectNamespacePath)
      .mockImplementationOnce(async () => await new Promise<never>(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({} as never);
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await Promise.resolve();
    await wrapper.setProps({ requestedNamespacePath: "/docs/notes.txt" });
    resolveFirst?.({} as never);
    await flushPromises();

    expect(authenticatedSession.inspectNamespacePath).toHaveBeenCalledTimes(4);
    expect(authenticatedSession.inspectNamespacePath).toHaveBeenLastCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs", "notes.txt"],
    });
  });

  it("does not publish physical authority loaded from a replaced authenticated source", async () => {
    let resolveContainer: ((value: never) => void) | undefined;
    const firstSession = createAuthenticatedSession();
    const secondSession = createAuthenticatedSession();
    vi.mocked(firstSession.inspectContainer).mockImplementationOnce(async () => await new Promise<never>(resolve => {
      resolveContainer = resolve;
    }));
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession: firstSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await Promise.resolve();
    await wrapper.setProps({ authenticatedSession: secondSession });
    resolveContainer?.({} as never);
    await flushPromises();

    expect(firstSession.inspectContainer).toHaveBeenCalledOnce();
    expect(secondSession.inspectContainer).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-container"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-error"]').exists()).toBe(false);
  });

  it("rejects an in-flight namespace result from a replaced authenticated source and replays the latest path", async () => {
    let resolveFirst: ((value: never) => void) | undefined;
    const firstSession = createAuthenticatedSession();
    const secondSession = createAuthenticatedSession();
    vi.mocked(firstSession.inspectNamespacePath).mockImplementationOnce(async () => await new Promise<never>(resolve => {
      resolveFirst = resolve;
    }));
    const onNamespaceInspected = vi.fn();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, {
      props: {
        authenticatedSession: firstSession,
        onNamespaceInspected,
        requestedNamespacePath: "/docs",
      },
    });
    await Promise.resolve();

    await wrapper.setProps({ authenticatedSession: secondSession });
    resolveFirst?.({} as never);
    await flushPromises();

    expect(firstSession.inspectNamespacePath).toHaveBeenCalledOnce();
    expect(secondSession.inspectNamespacePath).toHaveBeenCalledTimes(2);
    expect(secondSession.inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs"],
    });
    expect(onNamespaceInspected).toHaveBeenCalledTimes(1);
  });

  it("does not publish an authenticated namespace result after the source panel is unmounted", async () => {
    let resolveNamespace: ((value: never) => void) | undefined;
    const authenticatedSession = createAuthenticatedSession();
    vi.mocked(authenticatedSession.inspectNamespacePath).mockImplementationOnce(async () => await new Promise<never>(resolve => {
      resolveNamespace = resolve;
    }));
    const onNamespaceInspected = vi.fn();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, {
      props: { authenticatedSession, onNamespaceInspected },
    });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await Promise.resolve();
    wrapper.unmount();
    resolveNamespace?.({} as never);
    await flushPromises();

    expect(onNamespaceInspected).not.toHaveBeenCalled();
  });

  it("coalesces a Workbench namespace request received while another authenticated read is busy", async () => {
    let resolveContainer: ((value: never) => void) | undefined;
    const authenticatedSession = createAuthenticatedSession();
    vi.mocked(authenticatedSession.inspectContainer).mockImplementationOnce(async () => await new Promise<never>(resolve => {
      resolveContainer = resolve;
    }));
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await Promise.resolve();
    await wrapper.setProps({ requestedNamespacePath: "/docs/notes.txt" });
    expect(authenticatedSession.inspectNamespacePath).not.toHaveBeenCalled();

    resolveContainer?.({} as never);
    await flushPromises();

    expect(authenticatedSession.inspectNamespacePath).toHaveBeenCalledTimes(3);
    expect(authenticatedSession.inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs", "notes.txt"],
    });
  });

  it("opens an authenticated namespace page reference with a new one-shot passphrase", async () => {
    mocks.createRecordView.mockReturnValueOnce({
      identitySummary: "home 03:128; physical 03:128",
      navigationTargets: [],
      payloadDocumentLabel: "Exact decoded structural payload DTO",
      payloadJson: '{"kind":"inode_table_page"}',
      payloadSummary: "inode_table leaf, level 0, 1 items, root",
      plaintextSummary: "80/80 bytes previewed",
      recordKindName: "inode_table_page",
    });
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("namespace passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-namespace"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-namespace-column"]').exists()).toBe(false);
    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("page passphrase");
    await wrapper.get('[data-testid="hizofs-physical-inspector-validation-reference"]').trigger("click");
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

  it("keeps an evidence-only logical observation on namespace-derived records and returns to it", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-validation-reference"]').trigger("click");
    await flushPromises();

    const context = wrapper.get('[data-testid="hizofs-physical-inspector-record-logical-context"]');
    expect(context.text()).toContain("Observed while resolving active logical / at Commit 4");
    expect(context.text()).toContain("observation context, not ownership");
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-traversal"]').exists()).toBe(true);

    await wrapper.get('[data-testid="hizofs-physical-inspector-return-logical-context"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-traversal"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace"]').text()).toContain("Decrypted namespace /");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-path"]').element as HTMLInputElement).value).toBe("/");
  });

  it("selects child and parent namespace paths without retaining a credential", async () => {
    const inspector = createWorker();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { inspector } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').setValue("one-shot");
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    const pathInput = wrapper.get('[data-testid="hizofs-physical-inspector-path"]');
    await wrapper.get('[data-testid="hizofs-physical-inspector-namespace-entry"]').trigger("click");
    expect((pathInput.element as HTMLInputElement).value).toBe("/docs");
    expect(inspector.inspectNamespacePath).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-testid="hizofs-physical-inspector-select-namespace-column"]').trigger("click");
    expect((pathInput.element as HTMLInputElement).value).toBe("/");
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-passphrase"]').element as HTMLInputElement).value).toBe("");
  });

  it("follows namespace child and parent paths immediately with source-owned authority", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });

    await wrapper.get('[data-testid="hizofs-physical-inspector-read-namespace"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="hizofs-physical-inspector-namespace-entry"]').trigger("click");
    await flushPromises();
    expect(authenticatedSession.inspectNamespacePath).toHaveBeenLastCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs"],
    });

    const directoryEntries = wrapper.findAll('[data-testid="hizofs-physical-inspector-namespace-entry"]');
    await directoryEntries.at(-1)?.trigger("click");
    await flushPromises();
    expect(authenticatedSession.inspectNamespacePath).toHaveBeenLastCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ["docs", "notes.txt"],
    });
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-namespace-ancestor"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace"]').attributes("data-namespace-column-path"))
      .toBe("/docs/notes.txt");

    await wrapper.findAll('[data-testid="hizofs-physical-inspector-select-namespace-column"]')[0]?.trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-testid="hizofs-physical-inspector-path"]').element as HTMLInputElement).value).toBe("/");
    expect(authenticatedSession.inspectNamespacePath).toHaveBeenCalledTimes(3);
  });

  it("does not resurrect a closed reference branch when a record read resolves late", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const defaultRecordView = mocks.createRecordView();
    mocks.createRecordView.mockClear();
    mocks.createRecordView.mockReturnValueOnce({
      ...defaultRecordView,
      navigationTargets: [{
        label: "Root Inode Table",
        request: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "03",
          pageIsRoot: true,
          recordKind: 5,
        },
        targetType: "home_record",
      }],
    });

    let resolveChild: ((value: never) => void) | undefined;
    vi.mocked(authenticatedSession.inspectHomeRecord)
      .mockResolvedValueOnce({} as never)
      .mockImplementationOnce(async () => await new Promise<never>(resolve => {
        resolveChild = resolve;
      }));

    const wrapper = mount(HizoFSPhysicalInspectorPanel, { props: { authenticatedSession } });
    await wrapper.get('[data-testid="hizofs-physical-inspector-read-container"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-physical-inspector-root-navigation"]').trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-traversal-column"]')).toHaveLength(1);
    await wrapper.get('[data-testid="hizofs-physical-inspector-home-record"]').trigger("click");
    await Promise.resolve();
    await wrapper.get('[data-testid="hizofs-physical-inspector-close-traversal-column"]').trigger("click");
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-traversal"]').exists()).toBe(false);

    resolveChild?.({} as never);
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-record-traversal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-error"]').exists()).toBe(false);
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
    await wrapper.get('[data-testid="hizofs-physical-inspector-validation-reference"]').trigger("click");
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
  it("places Workbench controls inside their physical and logical projection surfaces", async () => {
    const authenticatedSession = createAuthenticatedSession();
    const wrapper = mount(HizoFSPhysicalInspectorPanel, {
      props: { authenticatedSession, embeddedInWorkbench: true },
    });

    expect(wrapper.find('[data-testid="hizofs-physical-inspector-embedded-control-column"]').exists()).toBe(false);
    expect(wrapper.find('#hizofs-physical-inspector-title').exists()).toBe(false);
    expect(wrapper.get('[data-workbench-inspector-surface="physical-authority"]').find('[data-testid="hizofs-physical-inspector-read-container"]').exists()).toBe(true);
    expect(wrapper.get('[data-workbench-inspector-surface="namespace"]').find('[data-testid="hizofs-physical-inspector-path-toolbar"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-column-scroll"]').attributes('data-embedded-columns')).toBe('true');

    await wrapper.get('[data-testid="hizofs-physical-inspector-path"]').setValue('/docs');
    await wrapper.get('[data-testid="hizofs-physical-inspector-path-toolbar"]').trigger('submit');
    await flushPromises();

    expect(authenticatedSession.inspectNamespacePath).toHaveBeenLastCalledWith({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      pathComponents: ['docs'],
    });
    expect(wrapper.findAll('[data-testid="hizofs-physical-inspector-path-toolbar"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-namespace"]').find('[data-testid="hizofs-physical-inspector-path-toolbar"]').exists()).toBe(true);
  });

});
