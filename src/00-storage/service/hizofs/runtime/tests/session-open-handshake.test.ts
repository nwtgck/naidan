import { describe, expect, it } from "vitest";
import {
  openRuntimeSessionWithAuthorityHandshake,
  tryOpenRuntimeSessionWithAuthorityHandshake,
} from "@/00-storage/service/hizofs/runtime/session-open-handshake";
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
      acquireSessionOwner: async () => {
        events.push("owner");
        return { release: async () => {
          events.push("owner-release");
        } };
      },
      captureAuthority: async () => {
        events.push("capture");
        return { revision: 1 };
      },
      coordinator: value,
      createSession: ({ sessionOwner: _sessionOwner, verified }) => {
        events.push(`create:${String(verified)}`);
        return { close: async () => undefined };
      },
      recheckAuthority: async ({ captured }) => {
        events.push(`recheck:${captured.revision}`);
      },
      releaseSessionOwner: async ({ sessionOwner }) => await sessionOwner.release(),
      verifyCapturedAuthority: async ({ captured }) => {
        events.push(`verify:${captured.revision}`);
        const writer = await value.acquireWriter();
        writer.release();
        return "verified";
      },
    });

    expect(session).toBeDefined();
    expect(events).toEqual(["capture", "verify:1", "owner", "recheck:1", "create:verified"]);
  });

  it("does not create or leak a session when unchanged recheck fails", async () => {
    const value = coordinator();
    let created = false;
    let ownerReleased = false;
    await expect(openRuntimeSessionWithAuthorityHandshake({
      acquireSessionOwner: async () => ({ release: async () => {
        ownerReleased = true;
      } }),
      captureAuthority: async () => ({ revision: 1 }),
      coordinator: value,
      createSession: () => {
        created = true;
        return { close: async () => undefined };
      },
      recheckAuthority: async () => {
        throw new Error("authority changed");
      },
      releaseSessionOwner: async ({ sessionOwner }) => await sessionOwner.release(),
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toThrow("authority changed");
    expect(created).toBe(false);
    expect(ownerReleased).toBe(true);
    const writer = await value.acquireWriter();
    writer.release();
  });

  it("returns busy after verification without recheck or resource construction", async () => {
    const value = coordinator();
    const events: string[] = [];
    const session = await tryOpenRuntimeSessionWithAuthorityHandshake({
      captureAuthority: async () => {
        events.push("capture");
        return { revision: 1 };
      },
      coordinator: value,
      createSession: () => {
        events.push("create");
        return { close: async () => undefined };
      },
      recheckAuthority: async () => {
        events.push("recheck");
      },
      releaseSessionOwner: async () => {
        events.push("owner-release");
      },
      tryAcquireSessionOwner: async () => {
        events.push("try-owner");
        return undefined;
      },
      verifyCapturedAuthority: async () => {
        events.push("verify");
        return "verified";
      },
    });
    expect(session).toBeUndefined();
    expect(events).toEqual(["capture", "verify", "try-owner"]);
  });


  it("releases a non-blocking owner when final resource construction fails", async () => {
    const value = coordinator();
    let released = false;
    await expect(tryOpenRuntimeSessionWithAuthorityHandshake({
      captureAuthority: async () => ({ revision: 1 }),
      coordinator: value,
      createSession: () => {
        throw new Error("resource construction failed");
      },
      recheckAuthority: async () => undefined,
      releaseSessionOwner: async () => {
        released = true;
      },
      tryAcquireSessionOwner: async () => ({ owner: true }),
      verifyCapturedAuthority: async () => "verified",
    })).rejects.toThrow("resource construction failed");
    expect(released).toBe(true);
  });

});
