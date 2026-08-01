import { describe, expect, it } from "vitest";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";

describe("persisted audit JSON", () => {
  it("renders BigInt and bytes without losing their exact value", () => {
    expect(stringifyPersistedAuditValue({
      value: {
        bytes: Uint8Array.of(0, 15, 255),
        sequence: 18_446_744_073_709_551_615n,
      },
    })).toBe(`\
{
  "bytes": {
    "byteLength": 3,
    "hex": "000fff"
  },
  "sequence": "18446744073709551615"
}`);
  });

  it("reports an unavailable optional DTO explicitly", () => {
    expect(stringifyPersistedAuditValue({ value: undefined })).toBe("unavailable");
  });
});
