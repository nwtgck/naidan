import { describe, expect, it } from "vitest";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

describe("serializeInvestigationError", () => {
  it("preserves a bounded cause chain and redacts sensitive custom properties", () => {
    const cause = Object.assign(new TypeError("session create failed"), { authorization: "Bearer secret" });
    const error = Object.assign(new Error("model load failed", { cause }), { candidate: "webgpu-q4" });

    const result = serializeInvestigationError({ error });

    expect(result).toMatchObject({
      name: "Error",
      message: "model load failed",
      thrownType: "Error",
      cause: {
        name: "TypeError",
        message: "session create failed",
      },
    });
    expect(result.serializedOriginalThrownValue).toContain("webgpu-q4");
    expect(result.cause?.serializedOriginalThrownValue).toContain("[REDACTED]");
    expect(result.cause?.serializedOriginalThrownValue).not.toContain("Bearer secret");
  });

  it("preserves cyclic non-Error throws without throwing and bounds their size", () => {
    const thrown: { message: string, self?: unknown } = { message: "x".repeat(200) };
    thrown.self = thrown;

    const result = serializeInvestigationError({ error: thrown, maxLength: 80 });

    expect(result.name).toBe("object");
    expect(result.serializedOriginalThrownValue).toContain("[truncated");
  });

  it("redacts secrets embedded in messages, stacks, URL queries, and nested strings", () => {
    const error = Object.assign(
      new Error("fetch failed: https://example.invalid/model?token=secret-token&revision=main"),
      { detail: "Authorization: Bearer nested-secret" },
    );
    error.stack = `\
Error: failed
Authorization: Bearer stack-secret
Cookie: session=secret-cookie`;

    const result = serializeInvestigationError({ error });

    expect(result.message).toContain("token=[REDACTED]");
    expect(result.message).not.toContain("secret-token");
    expect(result.stack).toContain("Authorization: [REDACTED]");
    expect(result.stack).toContain("Cookie: [REDACTED]");
    expect(result.serializedOriginalThrownValue).not.toContain("nested-secret");
    expect(result.serializedOriginalThrownValue).toContain("Authorization: [REDACTED]");
  });
});
