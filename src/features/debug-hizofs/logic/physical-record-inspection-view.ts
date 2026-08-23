import type {
  HizoFSHomeRecordInspectionRequest,
  HizoFSPhysicalRecordInspection,
  HizoFSPhysicalRecordInspectionRequest,
  HizoFSRecordNavigationReferenceInspection,
  HizoFSRecordPayloadInspection,
} from "@/00-storage/service/hizofs/inspection";
import { exactObject } from "@/utils/exact-object";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";

/**
 * This is an audit projection of an exact decrypted record inspection. Preserve
 * the complete header, location, preview, and payload DTO instead of reducing it
 * to a user-facing summary; the summaries are only additive navigation aids.
 */

export type HizoFSPhysicalRecordNavigationTarget =
  | Readonly<{
      label: string;
      request: HizoFSHomeRecordInspectionRequest;
      targetType: "home_record";
    }>
  | Readonly<{
      label: string;
      request: HizoFSPhysicalRecordInspectionRequest;
      targetType: "physical_record";
    }>;

export type HizoFSPhysicalRecordInspectionView = Readonly<{
  frameLength: number;
  header: HizoFSPhysicalRecordInspection["header"];
  headerFlags: number;
  headerJson: string;
  homeOffset: string;
  homeSegmentId: string;
  identitySummary: string;
  navigationTargets: readonly HizoFSPhysicalRecordNavigationTarget[];
  payload: HizoFSRecordPayloadInspection;
  payloadDocumentLabel: "Bounded File Data inspection" | "Exact decoded structural payload DTO" | "Payload decode state";
  payloadJson: string;
  payloadSummary: string;
  physicalOffset: string;
  physicalSegmentId: string;
  plaintextByteLength: number;
  plaintextPreviewBase64Url: string;
  plaintextPreviewByteLength: number;
  plaintextPreviewTruncated: boolean;
  plaintextSummary: string;
  recordKind: number;
  recordKindName: HizoFSPhysicalRecordInspection["recordKindName"];
  sealedLength: number;
}>;

function payloadSummary({ payload }: {
  payload: HizoFSRecordPayloadInspection;
}): string {
  switch (payload.state) {
  case "decoded":
    if ("family" in payload) {
      const {
        decodedPayload: _decodedPayload,
        family,
        isRoot,
        itemCount,
        level,
        navigationReferences: _navigationReferences,
        pageType,
        state: _state,
        ...unhandledPayload
      } = payload;
      unhandledPayload satisfies Record<PropertyKey, never>;
      return `${family} ${pageType}, level ${level}, ${itemCount} items, ${isRoot ? "root" : "non-root"}`;
    }
    switch (payload.kind) {
    case "file_data": {
      const { byteLength, kind: _kind, state: _state, ...unhandledPayload } = payload;
      unhandledPayload satisfies Record<PropertyKey, never>;
      return `file data, ${byteLength} bytes`;
    }
    case "file_system_commit": {
      const {
        commitSequence,
        decodedPayload: _decodedPayload,
        kind: _kind,
        navigationReferences: _navigationReferences,
        nextInodeNumber,
        nextSubvolumeId,
        rootDirectoryInodeNumber,
        state: _state,
        ...unhandledPayload
      } = payload;
      unhandledPayload satisfies Record<PropertyKey, never>;
      return `Commit ${commitSequence}, root inode ${rootDirectoryInodeNumber}, next inode ${nextInodeNumber}, next Subvolume ${nextSubvolumeId}`;
    }
    default: return payload satisfies never;
    }
  case "invalid": {
    const { reason, state: _state, ...unhandledPayload } = payload;
    unhandledPayload satisfies Record<PropertyKey, never>;
    return `invalid payload: ${reason}`;
  }
  case "page_role_required": {
    const { family, state: _state, ...unhandledPayload } = payload;
    unhandledPayload satisfies Record<PropertyKey, never>;
    return `${family} page requires explicit root context`;
  }
  default: return payload satisfies never;
  }
}

function payloadDocumentLabel({ payload }: {
  payload: HizoFSRecordPayloadInspection;
}): HizoFSPhysicalRecordInspectionView["payloadDocumentLabel"] {
  switch (payload.state) {
  case "decoded":
    if ("family" in payload) return "Exact decoded structural payload DTO";
    switch (payload.kind) {
    case "file_data": return "Bounded File Data inspection";
    case "file_system_commit": return "Exact decoded structural payload DTO";
    default: return payload satisfies never;
    }
  case "invalid":
  case "page_role_required": return "Payload decode state";
  default: return payload satisfies never;
  }
}

function exactPayloadAuditValue({ payload }: {
  payload: HizoFSRecordPayloadInspection;
}): unknown {
  switch (payload.state) {
  case "decoded":
    if ("family" in payload) return payload.decodedPayload;
    switch (payload.kind) {
    case "file_data":
      // File Data bytes remain subject to the explicit preview bound on the
      // enclosing record inspection; structural metadata is not truncated.
      return payload;
    case "file_system_commit": return payload.decodedPayload;
    default: return payload satisfies never;
    }
  case "invalid":
  case "page_role_required": return payload;
  default: return payload satisfies never;
  }
}

function navigationLabel({ index, role }: {
  index: number;
  role: HizoFSRecordNavigationReferenceInspection["role"];
}): string {
  switch (role) {
  case "directory_child_page": return `Directory child page ${String(index + 1)}`;
  case "directory_tree_root": return "Directory tree root";
  case "file_data": return `File Data ${String(index + 1)}`;
  case "file_extent_child_page": return `File Extent child page ${String(index + 1)}`;
  case "file_extent_tree_root": return "File Extent tree root";
  case "inode_table_child_page": return `Inode Table child page ${String(index + 1)}`;
  case "nested_subvolume_child_page": return `Nested Subvolume child page ${String(index + 1)}`;
  case "root_inode_table_root": return "Root Inode Table";
  case "nested_subvolume_table_root": return "Nested Subvolume Table";
  case "relocated_record": return `Relocated record ${String(index + 1)}`;
  case "relocation_child_page": return `Relocation child page ${String(index + 1)}`;
  case "subvolume_inode_table_root": return `Subvolume Inode Table ${String(index + 1)}`;
  default: return role satisfies never;
  }
}

function navigationTarget({ index, reference }: {
  index: number;
  reference: HizoFSRecordNavigationReferenceInspection;
}): HizoFSPhysicalRecordNavigationTarget {
  const label = navigationLabel({ index, role: reference.role });
  switch (reference.targetType) {
  case "home_record": {
    const {
      frameLength,
      homeOffset,
      homeSegmentId,
      pageIsRoot,
      recordKind,
      role: _role,
      targetType: _targetType,
      ...unhandledReference
    } = reference;
    unhandledReference satisfies Record<PropertyKey, never>;
    return exactObject<Extract<HizoFSPhysicalRecordNavigationTarget, { targetType: "home_record" }>>()({
      label,
      request: {
        frameLength,
        homeOffset,
        homeSegmentId,
        ...(pageIsRoot === undefined ? {} : { pageIsRoot }),
        recordKind,
      },
      targetType: "home_record",
    });
  }
  case "physical_record": {
    const {
      frameLength,
      homeOffset,
      homeSegmentId,
      pageIsRoot,
      physicalOffset,
      physicalSegmentId,
      recordKind,
      role: _role,
      targetType: _targetType,
      ...unhandledReference
    } = reference;
    unhandledReference satisfies Record<PropertyKey, never>;
    return exactObject<Extract<HizoFSPhysicalRecordNavigationTarget, { targetType: "physical_record" }>>()({
      label,
      request: {
        frameLength,
        ...(homeOffset === undefined ? {} : { homeOffset }),
        ...(homeSegmentId === undefined ? {} : { homeSegmentId }),
        ...(pageIsRoot === undefined ? {} : { pageIsRoot }),
        physicalOffset,
        physicalSegmentId,
        recordKind,
      },
      targetType: "physical_record",
    });
  }
  default: return reference satisfies never;
  }
}

function navigationReferences({ payload }: {
  payload: HizoFSRecordPayloadInspection;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  switch (payload.state) {
  case "decoded":
    if ("family" in payload) return payload.navigationReferences;
    switch (payload.kind) {
    case "file_data": return [];
    case "file_system_commit": return payload.navigationReferences;
    default: return payload satisfies never;
    }
  case "invalid":
  case "page_role_required": return [];
  default: return payload satisfies never;
  }
}

export function createHizoFSPhysicalRecordInspectionView({ inspection }: {
  inspection: HizoFSPhysicalRecordInspection;
}): HizoFSPhysicalRecordInspectionView {
  const {
    frameLength,
    header,
    headerFlags,
    homeOffset,
    homeSegmentId,
    physicalOffset,
    physicalSegmentId,
    plaintextByteLength,
    plaintextPreviewBase64Url,
    plaintextPreviewByteLength,
    plaintextPreviewTruncated,
    payload,
    recordKind,
    recordKindName,
    sealedLength,
    ...unhandledInspection
  } = inspection;
  unhandledInspection satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSPhysicalRecordInspectionView>()({
    frameLength,
    header,
    headerFlags,
    headerJson: stringifyPersistedAuditValue({ value: header }),
    homeOffset,
    homeSegmentId,
    identitySummary: `home ${homeSegmentId}:${homeOffset}; physical ${physicalSegmentId}:${physicalOffset}`,
    navigationTargets: navigationReferences({ payload }).map((reference, index) => navigationTarget({ index, reference })),
    payload,
    payloadDocumentLabel: payloadDocumentLabel({ payload }),
    payloadJson: stringifyPersistedAuditValue({ value: exactPayloadAuditValue({ payload }) }),
    payloadSummary: payloadSummary({ payload }),
    physicalOffset,
    physicalSegmentId,
    plaintextByteLength,
    plaintextPreviewBase64Url,
    plaintextPreviewByteLength,
    plaintextPreviewTruncated,
    plaintextSummary: `${plaintextPreviewByteLength}/${plaintextByteLength} bytes previewed${plaintextPreviewTruncated ? " (truncated)" : ""}`,
    recordKind,
    recordKindName,
    sealedLength,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
