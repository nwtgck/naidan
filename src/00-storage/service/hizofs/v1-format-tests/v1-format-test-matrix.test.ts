import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  HIZOFS_V1_FORMAT_TEST_MATRIX,
  HIZOFS_V1_FORMAT_TEST_REMAINING_AREAS,
  type HizoFSV1FormatTestCoverageArea,
  type HizoFSV1FormatTestCoverageAreaId,
} from "./v1-format-test-matrix";
import { describe, expect, it } from "vitest";

describe("HizoFS V1 format test coverage matrix", () => {
  it("keeps the explicitly unresolved V1 areas visible instead of silently treating them as covered", () => {
    expect(HIZOFS_V1_FORMAT_TEST_REMAINING_AREAS).toEqual([
      "credential_slot_add_remove_lifecycle",
      "persisted_snapshot_subvolume_lifecycle",
    ] satisfies readonly HizoFSV1FormatTestCoverageAreaId[]);
  });

  it("requires every coverage entry to carry reviewable rationale and evidence", () => {
    for (const [id, area] of Object.entries(HIZOFS_V1_FORMAT_TEST_MATRIX) as readonly [
      HizoFSV1FormatTestCoverageAreaId,
      HizoFSV1FormatTestCoverageArea,
    ][]) {
      const { evidence, rationale, status, ...unhandled } = area;
      unhandled satisfies Record<PropertyKey, never>;
      expect(id.length).toBeGreaterThan(0);
      expect(evidence.length).toBeGreaterThan(0);
      for (const relativePath of evidence) {
        expect(existsSync(resolve(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests", relativePath))).toBe(true);
      }
      expect(rationale.length).toBeGreaterThan(0);
      expect([
        "blocked_by_current_public_surface",
        "covered",
        "intentionally_unfrozen",
        "outside_persisted_format_scope",
        "remaining",
      ]).toContain(status);
    }
  });
});
