import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { CrossRealmLockCoordinator } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";

function commitReference(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + BigInt(seed) * 8n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) }),
  } });
}

function scopeToken(seed: number) {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => seed + index);
  const value = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return parseContainerCoordinationScopeToken({ value });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("in-memory cross-realm lock model", () => {
  it("serializes writer ownership across independent coordinator instances", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRealm = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const secondRealm = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const first = await firstRealm.acquireWriter();
    let secondResolved = false;
    const secondPromise = secondRealm.acquireWriter().then(value => {
      secondResolved = true;
      return value;
    });
    await flushMicrotasks();
    expect(secondResolved).toBe(false);
    first.release();
    const second = await secondPromise;
    second.release();
  });

  it("does not merge byte-copied backing locations with distinct scope tokens", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const original = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const copied = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(2) });
    const originalWriter = await original.acquireWriter();
    const copiedWriter = await copied.acquireWriter();
    originalWriter.release();
    copiedWriter.release();
  });

  it("holds the registration gate throughout maintenance and captures existing pins", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const firstRealm = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const secondRealm = new CrossRealmLockCoordinator({ lockPort: port, maxHeldLockNames: 64, scopeToken: scopeToken(1) });
    const existingPin = await firstRealm.acquireReaderPin({ commitReference: commitReference(1) });
    const maintenance = await firstRealm.beginMaintenance();
    expect(maintenance.pinnedCommitReferences).toHaveLength(1);
    let newPinResolved = false;
    const newPinPromise = secondRealm.acquireReaderPin({ commitReference: commitReference(2) }).then(value => {
      newPinResolved = true;
      return value;
    });
    await flushMicrotasks();
    expect(newPinResolved).toBe(false);
    maintenance.release();
    const newPin = await newPinPromise;
    existingPin.release();
    newPin.release();
  });

  it("reports a busy exclusive lock without enqueuing a non-blocking request", async () => {
    const port = new InMemoryCrossRealmLockPort();
    const held = await port.acquire({ mode: "exclusive", name: "runtime-owner" });
    await expect(port.tryAcquire({ mode: "exclusive", name: "runtime-owner" })).resolves.toBeUndefined();
    held.release();
    await held.released;
    const acquired = await port.tryAcquire({ mode: "exclusive", name: "runtime-owner" });
    expect(acquired).toBeDefined();
    acquired?.release();
    await acquired?.released;
  });

});
