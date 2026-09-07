import { describe, expect, it } from "vitest";
import { inspectChatPersistenceRoundTrip } from "@/features/transformers-js/model-support-investigation/logic/inspect-chat-persistence-roundtrip";

describe("inspectChatPersistenceRoundTrip", () => {
  it("preserves model-visible tool history through the production DTO JSON contract", async () => {
    const result = await inspectChatPersistenceRoundTrip();

    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error(result.error.message);

    expect(result.fixtureId).toBe("tool-call-history-v1");
    expect(result.method).toBe("chat-content-dto-json-roundtrip-v1");
    expect(result.serializedByteLength).toBeGreaterThan(0);
    expect(result.serializedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.exactModelVisibleMatch).toBe(true);
    expect(result.firstMismatchIndex).toBeUndefined();
    expect(result.restoredMessages).toEqual(result.originalMessages);

    const assistant = result.restoredMessages.find(message => message.role === "assistant");
    expect(assistant?.content).toBe("<think>preserve this exact model-visible tool-call prefix</think>");
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe("{\n  \"city\": \"Tokyo\",\n  \"unit\": \"C\"\n}");

    const tool = result.restoredMessages.find(message => message.role === "tool");
    expect(tool?.tool_call_id).toBe("model-support-investigation-tool-call-1");
    expect(tool?.content).toContain("{\"temperatureC\":20,\"condition\":\"clear\"}\nsource=fixture");
  });
});
