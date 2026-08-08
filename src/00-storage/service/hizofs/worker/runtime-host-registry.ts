import type { ContainerRuntimeHostDisposalResult } from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { ContainerCoordinationScope } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import type { HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";

export type HizoFSRuntimeHostRegistryErrorCode =
  | "runtime_disposal_in_progress"
  | "runtime_policy_conflict";

export class HizoFSRuntimeHostRegistryError extends Error {
  readonly code: HizoFSRuntimeHostRegistryErrorCode;

  constructor({ code, message }: { code: HizoFSRuntimeHostRegistryErrorCode; message: string }) {
    super(message);
    this.name = "HizoFSRuntimeHostRegistryError";
    this.code = code;
  }
}

export type HizoFSRuntimeHostRegistryHost = Readonly<{
  disposeIfIdleAndSafe: () => Promise<ContainerRuntimeHostDisposalResult>;
  flushAndDisposeIfIdleAndSafe: () => Promise<ContainerRuntimeHostDisposalResult>;
}>;

export type HizoFSRuntimeHostRegistryDisposalResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "evicted" }>
  | Extract<ContainerRuntimeHostDisposalResult, { readonly status: "retained" }>;

type RuntimeHostEntry<Host> = {
  disposal: Promise<ContainerRuntimeHostDisposalResult> | undefined;
  host: Host;
  policyIdentity: string;
};

function runtimePolicyIdentity({ policy }: { policy: HizoFSRuntimePolicy }): string {
  return [
    policy.lazyDurability.publicationModeRequest,
    policy.lazyDurability.maximumAcceptedMutationsPerDirtyEpoch,
    policy.lazyDurability.maximumDirtyAgeMilliseconds,
    policy.lazyDurability.maximumDirtyMetadataBytes,
    policy.lazyDurability.maximumMutationAdmissionWaiters,
    policy.lazyDurability.maximumSyncWaiters,
    policy.lazyDurability.maximumUnpublishedPhysicalBytes,
    policy.maxDirectoryIteratorEntries,
    policy.maxHeldLockNames,
    policy.maxMaintenanceRootRegistrations,
    policy.maxReaderPins,
    policy.maxSegmentReferences,
  ].join(":");
}

/**
 * Owns one same-realm HizoFS runtime host per browser LockManager and canonical
 * container coordination scope. The registry is intentionally runtime-only;
 * it never participates in persisted identity, authorization, or key
 * derivation.
 */
export class HizoFSRuntimeHostRegistry<LockManager extends object, Host extends HizoFSRuntimeHostRegistryHost> {
  private readonly entriesByLockManager = new WeakMap<LockManager, Map<string, RuntimeHostEntry<Host>>>();

  getOrCreate({ createHost, lockManager, policy, scope }: {
    createHost: ({ lockManager, policy, scope }: {
      lockManager: LockManager;
      policy: HizoFSRuntimePolicy;
      scope: ContainerCoordinationScope;
    }) => Host;
    lockManager: LockManager;
    policy: HizoFSRuntimePolicy;
    scope: ContainerCoordinationScope;
  }): Host {
    let entries = this.entriesByLockManager.get(lockManager);
    if (entries === undefined) {
      entries = new Map();
      this.entriesByLockManager.set(lockManager, entries);
    }
    const key = scope.token;
    const policyIdentity = runtimePolicyIdentity({ policy });
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (existing.disposal !== undefined) {
        throw new HizoFSRuntimeHostRegistryError({
          code: "runtime_disposal_in_progress",
          message: "HizoFS runtime host disposal is in progress for this container scope",
        });
      }
      if (existing.policyIdentity !== policyIdentity) {
        throw new HizoFSRuntimeHostRegistryError({
          code: "runtime_policy_conflict",
          message: "one container coordination scope cannot use multiple runtime policies in the same provider lifetime",
        });
      }
      return existing.host;
    }
    const host = createHost({ lockManager, policy, scope });
    entries.set(key, { disposal: undefined, host, policyIdentity });
    return host;
  }

  private async disposeScopeIfIdleAndSafeInternal({ flushBeforeDispose, lockManager, scope }: {
    flushBeforeDispose: boolean;
    lockManager: LockManager;
    scope: ContainerCoordinationScope;
  }): Promise<HizoFSRuntimeHostRegistryDisposalResult> {
    const entries = this.entriesByLockManager.get(lockManager);
    if (entries === undefined) return Object.freeze({ status: "absent" });
    const key = scope.token;
    const entry = entries.get(key);
    if (entry === undefined) return Object.freeze({ status: "absent" });
    entry.disposal ??= flushBeforeDispose
      ? entry.host.flushAndDisposeIfIdleAndSafe()
      : entry.host.disposeIfIdleAndSafe();
    const disposal = entry.disposal;
    let result: ContainerRuntimeHostDisposalResult;
    try {
      result = await disposal;
    } finally {
      if (entry.disposal === disposal) entry.disposal = undefined;
    }
    switch (result.status) {
    case "disposed":
      if (entries.get(key) === entry) entries.delete(key);
      if (entries.size === 0) this.entriesByLockManager.delete(lockManager);
      return Object.freeze({ status: "evicted" });
    case "retained": return result;
    default: return result satisfies never;
    }
  }

  async disposeScopeIfIdleAndSafe({ lockManager, scope }: {
    lockManager: LockManager;
    scope: ContainerCoordinationScope;
  }): Promise<HizoFSRuntimeHostRegistryDisposalResult> {
    return await this.disposeScopeIfIdleAndSafeInternal({ flushBeforeDispose: false, lockManager, scope });
  }

  async flushAndDisposeScopeIfIdleAndSafe({ lockManager, scope }: {
    lockManager: LockManager;
    scope: ContainerCoordinationScope;
  }): Promise<HizoFSRuntimeHostRegistryDisposalResult> {
    return await this.disposeScopeIfIdleAndSafeInternal({ flushBeforeDispose: true, lockManager, scope });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  runtimePolicyIdentity,
};
