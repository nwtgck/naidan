import { exactObject } from "@/utils/exact-object";

export type HizoFSV1FormatTestCoverageStatus =
  | "covered"
  | "blocked_by_current_public_surface"
  | "remaining"
  | "intentionally_unfrozen"
  | "outside_persisted_format_scope";

export type HizoFSV1FormatTestCoverageAreaId =
  | "crash_recovery"
  | "credential_persisted_semantics"
  | "credential_publication_systematic_fault_campaign"
  | "credential_slot_add_remove_lifecycle"
  | "declarative_writer"
  | "exact_format_anchors"
  | "explicit_bulk_lifecycle"
  | "historical_reader"
  | "negative_and_legal_corpus"
  | "persisted_snapshot_subvolume_lifecycle"
  | "session_semantics"
  | "writer_physical_strategy";

export type HizoFSV1FormatTestCoverageArea = Readonly<{
  evidence: readonly string[];
  rationale: string;
  status: HizoFSV1FormatTestCoverageStatus;
}>;

type HizoFSV1FormatTestMatrix = Readonly<Record<
  HizoFSV1FormatTestCoverageAreaId,
  HizoFSV1FormatTestCoverageArea
>>;

export const HIZOFS_V1_FORMAT_TEST_MATRIX = Object.freeze(exactObject<HizoFSV1FormatTestMatrix>()({
  crash_recovery: {
    evidence: Object.freeze([
      "hizofs-v1-crash-consistency.test.ts",
      "hizofs-v1-fault-campaign.test.ts",
      "hizofs-v1-legal-variant-read.test.ts",
    ]),
    rationale: "Crash/reopen and dynamic fault-point campaigns compare V1 allowed observable states without freezing physical operation counts or ordering.",
    status: "covered",
  },
  credential_persisted_semantics: {
    evidence: Object.freeze([
      "hizofs-v1-credential-lifecycle.test.ts",
      "hizofs-v1-read.test.ts",
      "hizofs-v1-authority-conflict.test.ts",
    ]),
    rationale: "Replacement, multiple retained slots, passphrase bounds, rollback protection, crash-after-acknowledgement, and historical reopen/update are covered.",
    status: "covered",
  },
  credential_publication_systematic_fault_campaign: {
    evidence: Object.freeze(["hizofs-v1-credential-lifecycle.test.ts"]),
    rationale: "The black-box campaign discovers the current credential replacement write surface at runtime and reinjects faults at every observed file-durability transition without anchoring the number or order of physical operations.",
    status: "covered",
  },
  credential_slot_add_remove_lifecycle: {
    evidence: Object.freeze(["README.md"]),
    rationale: "The current application-level management surface exposes replacement but not Credential Slot add/remove operations.",
    status: "blocked_by_current_public_surface",
  },
  declarative_writer: {
    evidence: Object.freeze([
      "hizofs-v1-write.test.ts",
      "scenarios/scenario-types.ts",
      "model/reference-filesystem-model.ts",
    ]),
    rationale: "Current and frozen-historical V1 containers are mutated through observable operations and compared after fresh reopen against the independent reference model.",
    status: "covered",
  },
  exact_format_anchors: {
    evidence: Object.freeze(["hizofs-v1-format-anchors.test.ts"]),
    rationale: "V1 representations that are uniquely specified are anchored independently from current writer output, including scalar, Credential, canonical-JSON, and framing acceptance/rejection boundaries.",
    status: "covered",
  },
  explicit_bulk_lifecycle: {
    evidence: Object.freeze(["README.md"]),
    rationale: "Explicit bulk batches ordinary namespace mutations but does not define a distinct V1 persisted representation; transactional bulk runtime behavior remains owned by its application/filesystem tests rather than this format-compatibility owner.",
    status: "outside_persisted_format_scope",
  },
  historical_reader: {
    evidence: Object.freeze([
      "hizofs-v1-read.test.ts",
      "fixtures/manifest.json",
    ]),
    rationale: "Append-only real V1 containers with reviewed real-writer provenance cover representative, boundary, large/sparse/reflink, Unicode, credential, and mutation-history states through fresh readers.",
    status: "covered",
  },
  negative_and_legal_corpus: {
    evidence: Object.freeze([
      "hizofs-v1-invalid-read.test.ts",
      "hizofs-v1-legal-variant-read.test.ts",
      "legal-variant-fixtures/manifest.json",
      "negative-fixtures/manifest.json",
    ]),
    rationale: "Authenticated conflicts, rollback floors, missing/corrupt redundant objects, unsupported required features, truncation, and path/content misbinding have frozen acceptance/rejection evidence.",
    status: "covered",
  },
  persisted_snapshot_subvolume_lifecycle: {
    evidence: Object.freeze(["README.md"]),
    rationale: "The application-level session rejects Subvolume mounts until a topology-aware resolver is composed and currently exposes no persisted Snapshot/Subvolume lifecycle surface.",
    status: "blocked_by_current_public_surface",
  },
  session_semantics: {
    evidence: Object.freeze(["hizofs-v1-session-semantics.test.ts"]),
    rationale: "Read-only sessions, iterators, pinned read snapshots/readables, close behavior, writer ownership, and abort semantics are exercised against real persisted V1 state.",
    status: "covered",
  },
  writer_physical_strategy: {
    evidence: Object.freeze(["README.md"]),
    rationale: "Whole-container images, physical I/O counts/order, allocation, packing, random request order, and tunable writer policy are intentionally not compatibility anchors unless V1 authority makes them persisted semantics.",
    status: "intentionally_unfrozen",
  },
}));

export const HIZOFS_V1_FORMAT_TEST_REMAINING_AREAS = Object.freeze(
  (Object.entries(HIZOFS_V1_FORMAT_TEST_MATRIX) as readonly [HizoFSV1FormatTestCoverageAreaId, HizoFSV1FormatTestCoverageArea][])
    .filter(([, area]) => area.status === "blocked_by_current_public_surface" || area.status === "remaining")
    .map(([id]) => id),
);

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
