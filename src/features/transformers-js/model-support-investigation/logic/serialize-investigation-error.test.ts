import { describe, expect, it } from "vitest";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

describe("serializeInvestigationError", () => {
  it("preserves useful Error diagnostics and produces structured-clone-safe cause chains", () => {
    const cause = new TypeError("invalid payload ?token=secret-token");
    cause.stack = "TypeError: invalid payload ?token=secret-token\\n    at fixture";
    const error = new Error("repository request failed", { cause });
    error.stack = "Error: repository request failed\\n    at fixture";

    const result = serializeInvestigationError({ error });

    expect(result).toMatchObject({
      name: "Error",
      message: "repository request failed",
      thrownType: "Error",
      cause: {
        name: "TypeError",
        message: "invalid payload ?token=[REDACTED]",
        thrownType: "TypeError",
      },
    });
    expect(result.cause?.stack).not.toContain("secret-token");
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("serializes non-Error thrown values without retaining non-cloneable members or secrets", () => {
    type CircularFixture = {
      authorization: string,
      apiKey: string,
      count: bigint,
      callback: () => void,
      marker: symbol,
      self?: CircularFixture,
    };
    const thrown: CircularFixture = {
      authorization: "Bearer secret-credential",
      apiKey: "secret-api-key",
      count: 3n,
      callback: () => undefined,
      marker: Symbol("fixture"),
    };
    thrown.self = thrown;

    const result = serializeInvestigationError({ error: thrown });

    expect(result.thrownType).toBe("object");
    expect(result.serializedOriginalThrownValue).toContain("[REDACTED]");
    expect(result.serializedOriginalThrownValue).toContain("[Circular]");
    expect(result.serializedOriginalThrownValue).toContain("3n");
    expect(result.serializedOriginalThrownValue).not.toContain("secret-credential");
    expect(result.serializedOriginalThrownValue).not.toContain("secret-api-key");
    expect(() => structuredClone(result)).not.toThrow();
  });


  it("bounds object traversal before reading later properties", () => {
    const thrown: Record<string, unknown> = {};
    let lateGetterRead = false;
    for (let index = 0; index < 40; index += 1) {
      Object.defineProperty(thrown, `key${index}`, {
        enumerable: true,
        get() {
          if (index >= 32) lateGetterRead = true;
          return index;
        },
      });
    }

    const result = serializeInvestigationError({ error: thrown });

    expect(lateGetterRead).toBe(false);
    expect(result.serializedOriginalThrownValue).toContain("[Truncated]");
    expect(result.serializedOriginalThrownValue).not.toContain("key32");
  });

  it("summarizes typed-array payloads without enumerating elements", () => {
    const result = serializeInvestigationError({
      error: { tensorData: new Uint8Array(1_000_000) },
    });

    expect(result.serializedOriginalThrownValue).toContain('"type":"Uint8Array"');
    expect(result.serializedOriginalThrownValue).toContain('"byteLength":1000000');
    expect(result.serializedOriginalThrownValue).not.toContain('"999999"');
  });

  it("bounds Error message and stack fields before packaging", () => {
    const error = new Error(`failure-${"x".repeat(200)}`);
    error.stack = `Error: ${"y".repeat(200)}`;

    const result = serializeInvestigationError({ error, maxLength: 32 });

    expect(result.message).toContain("[truncated");
    expect(result.stack).toContain("[truncated");
    expect(result.message.length).toBeLessThan(80);
    expect(result.stack?.length).toBeLessThan(80);
  });
  it("does not throw when the thrown value cannot be inspected or stringified", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const result = serializeInvestigationError({ error: proxy });

    expect(result).toMatchObject({
      name: "object",
      message: "[Unstringifiable object]",
      thrownType: "object",
      serializedOriginalThrownValue: "[Unstringifiable object]",
    });
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("bounds serialized thrown values", () => {
    const result = serializeInvestigationError({
      error: { payload: "x".repeat(200) },
      maxLength: 32,
    });

    expect(result.serializedOriginalThrownValue).toContain("[truncated");
    expect(result.serializedOriginalThrownValue?.length).toBeLessThan(80);
  });
});
