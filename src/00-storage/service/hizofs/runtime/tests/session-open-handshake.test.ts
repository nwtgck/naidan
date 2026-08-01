import { describe, expect, it } from "vitest";
import { openRuntimeSessionWithAuthorityHandshake } from "@/00-storage/service/hizofs/runtime/session-open-handshake";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { CrossRealmLockCoordinator } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";

function coordinator() {
  const scope = createContainerCoordinationScope({
    token: parseContainerCoordinationScopeToken({ value: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI" }),
  });
  return new CrossRealmLockCoordinator({
    lockPort: new InMemoryCrossRealmLockPort(),
    maxHeldLockNames: 64,
    scopeToken: scope.token,
  });
}

describe("runtime session authority handshake", () => {
  it("performs expensive verification outside the short authority lease", async () => {
    const value = coordinator();
    const events: string[] = [];
    const session = await openRuntimeSessionWithAuthorityHandshake({
      captureAuthority: async () => {
        events.push("capture");
        return { revision: 1 };
      },
      coordinator: value,
      createSession: ({ verified }) => {
        events.push(`create:${String(verified)}`);
        return { close: async () => undefined };
      },
      recheckAuthority: async ({ captured }) => {
        events.push(`recheck:${captured.revision}`);
      },
      verifyCapturedAuthority: async ({ captured }) => {
        events.push(`verify:${captured.revision}`);
        const writer = await value.acquireWriter();
        writer.release();
        return "verified";
      },
    });

    expect(session).toBeDefined();
    expect(events).toEqual(["capture", "verify:1", "recheck:1", "create:verified"]);
  });

  it("does not create or leak a session when unchanged recheck fails", async () => {
    const value = coordinator();
    let created = false;
    await expect(openRuntimeSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      coordinator: value,
      createSession: () => {
        created = true;
        return { close: async () => undefined };
      },
      recheckAuthority: async () => {
        throw new Error("authority changed");
      },
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toThrow("authority changed");
    expect(created).toBe(false);
    const writer = await value.acquireWriter();
    writer.release();
  });
});
