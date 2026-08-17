import type {
  AuthenticatedMaintenanceRecordPort,
  AuthenticatedMaintenanceRecordRead,
} from "@/00-storage/service/hizofs/authenticated-store/maintenance-record-read-port";
import type {
  MaintenanceRecordReader,
  ResolvedMaintenanceRecord,
} from "@/00-storage/service/hizofs/maintenance/garbage-collection-mark-cursor";
import { projectMaintenanceRecordChildren } from "@/00-storage/service/hizofs/maintenance/maintenance-record-child-projection";
import {
  samePhysicalReference,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

function resolvedMaintenanceRecord({ item, read }: {
  item: MaintenanceTraversalItem;
  read: AuthenticatedMaintenanceRecordRead;
}): ResolvedMaintenanceRecord {
  try {
    if (item.kind === "physical_relocation_page"
      && !samePhysicalReference({ left: item.reference, right: read.record.physicalReference })) {
      throw new TypeError("authenticated maintenance reader returned a different physical record");
    }
    return Object.freeze({
      bytesRead: read.physicalBytesRead,
      childItems: projectMaintenanceRecordChildren({ item, plaintext: read.record.plaintext }),
      physicalReference: read.record.physicalReference,
    });
  } finally {
    read.record.plaintext.fill(0);
  }
}

export function createMaintenanceRecordReaderFromAuthenticatedPort({ port }: {
  port: AuthenticatedMaintenanceRecordPort;
}): MaintenanceRecordReader {
  return Object.freeze({
    readRecord: async ({ item }: { item: MaintenanceTraversalItem }) => {
      switch (item.kind) {
      case "logical_home":
        return resolvedMaintenanceRecord({
          item,
          read: await port.readLogicalRecord({ reference: item.reference }),
        });
      case "physical_relocation_page":
        return resolvedMaintenanceRecord({
          item,
          read: await port.readPhysicalRecord({ reference: item.reference }),
        });
      default:
        return item satisfies never;
      }
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
