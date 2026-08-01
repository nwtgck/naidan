import { describe, expect, it, vi } from "vitest";
import type { HizoFSTransitionImportJournalPort } from "@/00-storage/service/hizofs/api";
import { parseTransitionOperationId } from "@/00-storage/service/naidan-persistence-control/00-format";
import type { TransitionTargetOperationBinding } from "@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter";
import { TEST_ONLY } from "@/00-storage/service/naidan-opfs/production-persistence-runtime";
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from "@/00-storage/service/naidan-opfs/persistence-runtime-contract";

const FILE_SYSTEM_ID = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: "0123456789_ABCDEFGHIJ",
}).mode.activeFileSystemId;
const OTHER_FILE_SYSTEM_ID = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: "1123456789_ABCDEFGHIJ",
}).mode.activeFileSystemId;
const OPERATION_ID = parseTransitionOperationId({ value: "transition_0123456789" });
const binding: TransitionTargetOperationBinding = {
  operationId: OPERATION_ID,
  source: { type: "plain" },
  target: { fileSystemId: FILE_SYSTEM_ID, type: "hizofs" },
};

type DriverOptions = Parameters<typeof TEST_ONLY.createNativeHizoFSEnableTransitionDriverWith>[0];
type DriverRuntime = DriverOptions["runtime"];
type TargetReadiness = "absent" | "fully_verified" | "invalid" | "root_key_ready";

function driver({
  publishTarget,
  readiness = "root_key_ready",
  recheckPublicationAllowed = vi.fn(async () => undefined),
}: {
  publishTarget?: DriverRuntime["publishTarget"];
  readiness?: TargetReadiness;
  recheckPublicationAllowed?: DriverOptions["recheckPublicationAllowed"];
} = {}) {
  const containerRoot = Object.freeze({ name: "target" }) as unknown as FileSystemDirectoryHandle;
  const targetSession = Object.freeze({
    authorityIdentity: "target-authority",
    close: async () => undefined,
    source: Object.freeze({}),
    target: Object.freeze({}),
  }) as unknown as Awaited<ReturnType<DriverRuntime["openTargetSession"]>>;
  const runtime = {
    openContainerRoot: vi.fn(async () => containerRoot),
    openTargetSession: vi.fn(async () => targetSession),
    publishTarget: publishTarget ?? vi.fn(async ({ assertPublicationAllowed }) => {
      assertPublicationAllowed();
      assertPublicationAllowed();
      assertPublicationAllowed();
      return { commitSequence: 2n, fileSystemId: FILE_SYSTEM_ID };
    }),
    removeContainerRoot: vi.fn(async () => undefined),
    verifyNormalOpen: vi.fn(async () => ({ credentialSlotCount: 1 })),
  } satisfies DriverRuntime;
  const inspectTarget = vi.fn(async ({ openProfile }: { openProfile: "normal_read" | "root_key_proof" }) => (
    openProfile === "normal_read" ? "fully_verified" as const : readiness
  ));
  const result = TEST_ONLY.createNativeHizoFSEnableTransitionDriverWith({
    recheckPublicationAllowed,
    authorityIdentity: "target-authority",
    binding,
    exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
    initialOpenProfile: "root_key_proof",
    inspectTarget,
    journalBinding: {
      operationIdentity: OPERATION_ID,
      sourceAuthorityIdentity: "plain-authority",
      sourceEndpointIdentity: "plain",
      targetAuthorityIdentity: "target-authority",
      targetEndpointIdentity: `hizofs:${FILE_SYSTEM_ID}`,
    },
    journalPort: Object.freeze({}) as HizoFSTransitionImportJournalPort,
    limits: {
      directory: { maximumEntryMutationsPerBatch: 2 },
      file: { maximumExtentMutationsPerBatch: 2 },
    },
    normalOpenVerificationPassphrases: ["secret"],
    operationPassphrase: "secret",
    runtime,
    storageRoot: Object.freeze({ name: "storage" }) as unknown as FileSystemDirectoryHandle,
    verifyProofAuthority: vi.fn(async () => undefined),
  });
  return { inspectTarget, recheckPublicationAllowed, result, runtime, targetSession };
}

describe("native HizoFS enable transition driver", () => {
  it("binds target open, publication, normal-open proof, inspection, and cleanup to one operation", async () => {
    const { inspectTarget, result, runtime, targetSession } = driver();

    await expect(result.prepareTarget({ binding })).resolves.toBeUndefined();
    await expect(result.inspectEndpoint({ endpoint: binding.target })).resolves.toBe("root_key_ready");
    await expect(result.openTargetEndpoint({ binding })).resolves.toBe(targetSession);
    await expect(result.finalizeTarget({ binding })).resolves.toBeUndefined();
    await expect(result.inspectEndpoint({ endpoint: binding.target })).resolves.toBe("fully_verified");
    await expect(result.verifyNormalOpen({ binding })).resolves.toBeUndefined();
    await expect(result.cleanupEndpoint({ endpoint: binding.target })).resolves.toBeUndefined();

    expect(inspectTarget).toHaveBeenNthCalledWith(1, { openProfile: "root_key_proof" });
    expect(inspectTarget).toHaveBeenNthCalledWith(2, { openProfile: "root_key_proof" });
    expect(inspectTarget).toHaveBeenNthCalledWith(3, { openProfile: "normal_read" });
    expect(runtime.openTargetSession).toHaveBeenCalledTimes(1);
    expect(runtime.publishTarget).toHaveBeenCalledTimes(1);
    expect(runtime.verifyNormalOpen).toHaveBeenCalledTimes(1);
    expect(runtime.removeContainerRoot).toHaveBeenCalledTimes(1);
  });


  it("scopes one exact recheck to one publication invocation", async () => {
    let capturedGuard: (() => void) | undefined;
    const publishTarget: DriverRuntime["publishTarget"] = vi.fn(async ({ assertPublicationAllowed }) => {
      capturedGuard = assertPublicationAllowed;
      assertPublicationAllowed();
      assertPublicationAllowed();
      return { commitSequence: 2n, fileSystemId: FILE_SYSTEM_ID };
    });
    const fixture = driver({ publishTarget });

    await expect(fixture.result.finalizeTarget({ binding })).resolves.toBeUndefined();
    expect(fixture.recheckPublicationAllowed).toHaveBeenCalledOnce();
    expect(capturedGuard).toBeDefined();
    expect(() => capturedGuard?.()).toThrow("outside its exact Persistence Control recheck scope");
  });

  it("does not enter publication when the exact recheck rejects", async () => {
    const recheckFailure = new Error("control authority changed");
    const fixture = driver({
      recheckPublicationAllowed: vi.fn(async () => {
        throw recheckFailure;
      }),
    });

    await expect(fixture.result.finalizeTarget({ binding })).rejects.toBe(recheckFailure);
    expect(fixture.runtime.publishTarget).not.toHaveBeenCalled();
  });

  it("rejects another operation or endpoint before opening target state", async () => {
    const { result, runtime } = driver();
    const anotherOperation = { ...binding, operationId: parseTransitionOperationId({ value: "transition_1123456789" }) };
    const anotherEndpoint = { fileSystemId: OTHER_FILE_SYSTEM_ID, type: "hizofs" } as const;

    await expect(result.openTargetEndpoint({ binding: anotherOperation })).rejects.toThrow("another transition binding");
    await expect(result.finalizeTarget({ binding: { ...binding, target: anotherEndpoint } })).rejects.toThrow("another transition binding");
    await expect(result.inspectEndpoint({ endpoint: anotherEndpoint })).rejects.toThrow("another endpoint");
    await expect(result.cleanupEndpoint({ endpoint: anotherEndpoint })).rejects.toThrow("another endpoint");
    expect(runtime.openContainerRoot).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", "is absent"],
    ["invalid", "is invalid"],
  ] as const)("rejects %s targets during preparation", async (readiness, message) => {
    const { result } = driver({ readiness });
    await expect(result.prepareTarget({ binding })).rejects.toThrow(message);
  });

  it("does not impersonate a HizoFS source driver", async () => {
    const { result } = driver();
    await expect(result.openSourceEndpoint({ endpoint: binding.target })).rejects.toThrow("cannot open a source endpoint");
  });
});
