import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeCommonPageHeader,
  decodeDirectoryPage,
  decodeFileExtentPage,
  decodeFileSystemCommitPayload,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  decodeNestedSubvolumeBranchPage,
  decodeNestedSubvolumeLeafPage,
  decodeRelocationIndexPage,
} from "@/00-storage/service/hizofs/00-format";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
  type LogicalMaintenanceTraversalItem,
  type MaintenanceTraversalItem,
  type PhysicalRelocationMaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

const RECORD_KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function requireLogicalNonPage({ item }: { item: MaintenanceTraversalItem }): LogicalMaintenanceTraversalItem {
  if (item.kind !== "logical_home" || item.pageRole !== "not_page") {
    throw new TypeError("maintenance non-page record requires a logical non-page traversal item");
  }
  return item;
}

function requireLogicalPage({ item }: { item: MaintenanceTraversalItem }): Readonly<{
  isRoot: boolean;
  item: LogicalMaintenanceTraversalItem;
}> {
  if (item.kind !== "logical_home" || item.pageRole === "not_page") {
    throw new TypeError("maintenance logical page requires an explicit root or non-root role");
  }
  return { isRoot: item.pageRole === "root", item };
}

function requirePhysicalRelocationPage({ item }: {
  item: MaintenanceTraversalItem;
}): Readonly<{ isRoot: boolean; item: PhysicalRelocationMaintenanceTraversalItem }> {
  switch (item.kind) {
  case "physical_relocation_page":
    return { isRoot: item.pageRole === "root", item };
  case "logical_home":
    throw new TypeError("Relocation Index maintenance traversal requires a physical page item");
  default: {
    const exhaustive: never = item;
    throw new Error(`Unhandled maintenance traversal kind: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function logicalRoot({ reference }: {
  reference: LogicalMaintenanceTraversalItem["reference"];
}): LogicalMaintenanceTraversalItem {
  return createLogicalMaintenanceTraversalItem({ pageRole: "root", reference });
}

function logicalNonRoot({ reference }: {
  reference: LogicalMaintenanceTraversalItem["reference"];
}): LogicalMaintenanceTraversalItem {
  return createLogicalMaintenanceTraversalItem({ pageRole: "non_root", reference });
}

function logicalNonPage({ reference }: {
  reference: LogicalMaintenanceTraversalItem["reference"];
}): LogicalMaintenanceTraversalItem {
  return createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference });
}

/**
 * Projects authenticated record plaintext into the exact graph edges used by
 * maintenance marking. Persisted decoding stays owned by 00-format; this layer
 * only assigns traversal roles that are not encoded in a Record Reference.
 */
export function projectMaintenanceRecordChildren({ item, plaintext }: {
  item: MaintenanceTraversalItem;
  plaintext: Uint8Array;
}): readonly MaintenanceTraversalItem[] {
  switch (item.reference.recordKind) {
  case RECORD_KINDS.file_system_commit: {
    requireLogicalNonPage({ item });
    const commit = decodeFileSystemCommitPayload({ bytes: plaintext });
    const children: MaintenanceTraversalItem[] = [logicalRoot({ reference: commit.rootInodeTableRootHomeRef })];
    if (commit.nestedSubvolumeTableRootHomeRef !== null) {
      children.push(logicalRoot({ reference: commit.nestedSubvolumeTableRootHomeRef }));
    }
    return Object.freeze(children);
  }
  case RECORD_KINDS.inode_table_page: {
    const { isRoot } = requireLogicalPage({ item });
    const header = decodeCommonPageHeader({ bytes: plaintext, family: "inode", isRoot });
    if (header.level !== 0) {
      return Object.freeze(decodeInodeBranchPage({ bytes: plaintext, isRoot }).entries
        .map(entry => logicalNonRoot({ reference: entry.childPageHomeRef })));
    }
    const children: MaintenanceTraversalItem[] = [];
    for (const entry of decodeInodeLeafPage({ bytes: plaintext, isRoot }).entries) {
      switch (entry.inodeKind) {
      case "file":
        switch (entry.content.type) {
        case "inline":
          break;
        case "tree":
          children.push(logicalRoot({ reference: entry.content.extentTreeRootHomeRef }));
          break;
        default: {
          const exhaustive: never = entry.content;
          throw new Error(`Unhandled file content type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
        }
        }
        break;
      case "directory":
        switch (entry.content.type) {
        case "inline":
          break;
        case "tree":
          children.push(logicalRoot({ reference: entry.content.directoryTreeRootHomeRef }));
          break;
        default: {
          const exhaustive: never = entry.content;
          throw new Error(`Unhandled directory content type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
        }
        }
        break;
      case "symlink":
        break;
      default:
        entry satisfies never;
      }
    }
    return Object.freeze(children);
  }
  case RECORD_KINDS.nested_subvolume_table_page: {
    const { isRoot } = requireLogicalPage({ item });
    const header = decodeCommonPageHeader({ bytes: plaintext, family: "nestedSubvolume", isRoot });
    if (header.level !== 0) {
      return Object.freeze(decodeNestedSubvolumeBranchPage({ bytes: plaintext, isRoot }).entries
        .map(entry => logicalNonRoot({ reference: entry.childPageHomeRef })));
    }
    return Object.freeze(decodeNestedSubvolumeLeafPage({ bytes: plaintext, isRoot }).entries
      .map(entry => logicalRoot({ reference: entry.inodeTableRootHomeRef })));
  }
  case RECORD_KINDS.directory_page: {
    const { isRoot } = requireLogicalPage({ item });
    const page = decodeDirectoryPage({ bytes: plaintext, isRoot });
    switch (page.type) {
    case "branch":
      return Object.freeze(page.entries.map(entry => logicalNonRoot({ reference: entry.childPageHomeRef })));
    case "leaf":
      return Object.freeze([]);
    default: {
      const exhaustive: never = page;
      throw new Error(`Unhandled Directory page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  case RECORD_KINDS.file_extent_page: {
    const { isRoot } = requireLogicalPage({ item });
    const page = decodeFileExtentPage({ bytes: plaintext, isRoot });
    switch (page.type) {
    case "branch":
      return Object.freeze(page.entries.map(entry => logicalNonRoot({ reference: entry.childPageHomeRef })));
    case "leaf":
      return Object.freeze(page.entries.map(entry => logicalNonPage({ reference: entry.fileDataHomeRef })));
    default: {
      const exhaustive: never = page;
      throw new Error(`Unhandled File Extent page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  case RECORD_KINDS.file_data:
    requireLogicalNonPage({ item });
    return Object.freeze([]);
  case RECORD_KINDS.relocation_index_page: {
    const { isRoot } = requirePhysicalRelocationPage({ item });
    const page = decodeRelocationIndexPage({ bytes: plaintext, isRoot });
    switch (page.type) {
    case "leaf":
      // A relocation mapping changes where a logical record is read. It does
      // not independently make an otherwise unreachable logical record live.
      return Object.freeze([]);
    case "branch":
      return Object.freeze(page.entries.map(entry => createPhysicalRelocationMaintenanceTraversalItem({
        pageRole: "non_root",
        reference: entry.childPagePhysicalRef,
      })));
    default: {
      const exhaustive: never = page;
      throw new Error(`Unhandled Relocation Index page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  default:
    throw new TypeError("maintenance traversal encountered an unknown persisted record kind");
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
