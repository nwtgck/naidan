import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeRequiredHomeRecordReference,
  decodeRequiredPhysicalRecordReference,
  encodeBase64UrlUnpadded,
  encodeHomeRecordReference,
  encodePhysicalRecordReference,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";

export type MaintenanceLogicalPageRole = "not_page" | "non_root" | "root";
export type MaintenancePhysicalPageRole = "non_root" | "root";

export type LogicalMaintenanceTraversalItem = Readonly<{
  kind: "logical_home";
  pageRole: MaintenanceLogicalPageRole;
  reference: HomeRecordReference;
}>;

export type PhysicalRelocationMaintenanceTraversalItem = Readonly<{
  kind: "physical_relocation_page";
  pageRole: MaintenancePhysicalPageRole;
  reference: PhysicalRecordReference;
}>;

export type MaintenanceTraversalItem =
  | LogicalMaintenanceTraversalItem
  | PhysicalRelocationMaintenanceTraversalItem;

function cloneHomeReference({ reference }: { reference: HomeRecordReference }): HomeRecordReference {
  return decodeRequiredHomeRecordReference({ bytes: encodeHomeRecordReference({ reference }) });
}

function clonePhysicalReference({ reference }: { reference: PhysicalRecordReference }): PhysicalRecordReference {
  return decodeRequiredPhysicalRecordReference({ bytes: encodePhysicalRecordReference({ reference }) });
}

export function createLogicalMaintenanceTraversalItem({ pageRole, reference }: {
  pageRole: MaintenanceLogicalPageRole;
  reference: HomeRecordReference;
}): LogicalMaintenanceTraversalItem {
  return Object.freeze({ kind: "logical_home" as const, pageRole, reference: cloneHomeReference({ reference }) });
}

export function createPhysicalRelocationMaintenanceTraversalItem({ pageRole, reference }: {
  pageRole: MaintenancePhysicalPageRole;
  reference: PhysicalRecordReference;
}): PhysicalRelocationMaintenanceTraversalItem {
  if (reference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new TypeError("physical maintenance traversal accepts only Relocation Index page references");
  }
  return Object.freeze({
    kind: "physical_relocation_page" as const,
    pageRole,
    reference: clonePhysicalReference({ reference }),
  });
}

export function cloneMaintenanceTraversalItem({ item }: { item: MaintenanceTraversalItem }): MaintenanceTraversalItem {
  switch (item.kind) {
  case "logical_home":
    return createLogicalMaintenanceTraversalItem({ pageRole: item.pageRole, reference: item.reference });
  case "physical_relocation_page":
    return createPhysicalRelocationMaintenanceTraversalItem({ pageRole: item.pageRole, reference: item.reference });
  default:
    return item satisfies never;
  }
}

export function maintenanceTraversalReferenceIdentity({ item }: { item: MaintenanceTraversalItem }): string {
  switch (item.kind) {
  case "logical_home":
    return `logical:${encodeBase64UrlUnpadded({ bytes: encodeHomeRecordReference({ reference: item.reference }) })}`;
  case "physical_relocation_page":
    return `physical-relocation:${encodeBase64UrlUnpadded({ bytes: encodePhysicalRecordReference({ reference: item.reference }) })}`;
  default:
    return item satisfies never;
  }
}

export function maintenanceTraversalItemIdentity({ item }: { item: MaintenanceTraversalItem }): string {
  return `${maintenanceTraversalReferenceIdentity({ item })}:${item.pageRole}`;
}

export function samePhysicalReference({ left, right }: {
  left: PhysicalRecordReference;
  right: PhysicalRecordReference;
}): boolean {
  return encodeBase64UrlUnpadded({ bytes: encodePhysicalRecordReference({ reference: left }) })
    === encodeBase64UrlUnpadded({ bytes: encodePhysicalRecordReference({ reference: right }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
