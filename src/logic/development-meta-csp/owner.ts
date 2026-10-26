import type { parseCsp, ParsedCsp, ParsedCspPolicy } from '@/utils/csp';
import type { AppliedDevelopmentMetaCspForDocumentMessagesOnly, AppliedDevelopmentMetaCspForUiMessagesOnly, DevelopmentMetaCspAdditionNotForSecurity, DevelopmentMetaCspPrivacyBrokerStateNotForSecurity, DevelopmentMetaCspSnapshotNotForSecurity } from './types';

type Parser = typeof parseCsp;

function absentPrivacyBroker(): DevelopmentMetaCspPrivacyBrokerStateNotForSecurity {
  return Object.freeze({ kind: 'not-created', sessionId: undefined, syncId: undefined, requestedPolicyCount: 0, confirmedPolicyCount: 0, reason: undefined });
}

export function createDevelopmentMetaCspOwnerNotForSecurity({ environment }: {
  environment: Readonly<{ document: Document, loadParser(): Promise<Parser | undefined> }>,
}) {
  let snapshot: DevelopmentMetaCspSnapshotNotForSecurity = Object.freeze({ preparation: 'idle', reason: undefined, installation: Object.freeze({ kind: 'not-added' }), additions: Object.freeze([]), diagnostics: 'complete', privacyBroker: absentPrivacyBroker() });
  let applied: readonly AppliedDevelopmentMetaCspForDocumentMessagesOnly[] | undefined = Object.freeze([]);
  let parsedUnits = 0;
  let policyCount = 0;
  let tail = Promise.resolve();
  let parserLoading: Promise<Parser | undefined> | undefined;
  let latestFailure: string | undefined;
  const successfulValues = new Map<string, Readonly<{ addition: DevelopmentMetaCspAdditionNotForSecurity, complete: boolean }>>();
  const listeners = new Set<() => void>();

  function prepareParser(): Promise<Parser | undefined> {
    parserLoading ??= new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, 3_000);
      void Promise.resolve().then(() => environment.loadParser()).then(parser => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(parser);
        }
      }, () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      });
    });
    return parserLoading;
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Development diagnostics must never interrupt the application.
      }
    }
  }

  function unavailable({ reason }: { reason: DevelopmentMetaCspSnapshotNotForSecurity['reason'] }): void {
    snapshot = Object.freeze({ ...snapshot, preparation: 'unavailable', reason });
    notify();
  }

  function brokerAwaitingNewAddition(): DevelopmentMetaCspPrivacyBrokerStateNotForSecurity {
    const broker = snapshot.privacyBroker;
    switch (broker.kind) {
    case 'not-created': return broker;
    case 'pending':
    case 'confirmed':
    case 'unavailable': return Object.freeze({ ...broker, kind: 'pending', syncId: undefined, requestedPolicyCount: policyCount, reason: undefined });
    default: {
      const exhaustive: never = broker.kind;
      return exhaustive;
    }
    }
  }

  function record({ serialized, policies, parsed, source, complete, uncertain }: {
    serialized: string,
    policies: readonly ParsedCspPolicy[],
    parsed: ParsedCsp,
    source: 'saved-setting' | 'developer-action',
    complete: boolean,
    uncertain: boolean,
  }): void {
    const serializedPolicies = Object.freeze(policies.map(policy => policy.serialized));
    const addition: DevelopmentMetaCspAdditionNotForSecurity = Object.freeze({ serialized, policies: serializedPolicies, source });
    if (policies.length > 0) {
      successfulValues.set(serialized, Object.freeze({ addition, complete }));
      // Raw records mirror explicit managed DOM additions. Only the diagnostic
      // AST cache is bounded; its limit never controls feature execution.
      parsedUnits += serialized.length;
      policyCount += policies.length;
      if (applied !== undefined && parsedUnits <= 65_536 && policyCount <= 64 && !uncertain) {
        const actual: ParsedCsp = complete ? parsed : Object.freeze({ serialized: serializedPolicies.join(', '), policies: Object.freeze([...policies]), issues: Object.freeze(policies.flatMap(policy => policy.issues)) });
        applied = Object.freeze([...applied, Object.freeze({ serialized: actual.serialized, parsed: actual })]);
      } else {
        applied = undefined;
      }
    }
    if (uncertain) {
      applied = undefined;
    }
    snapshot = Object.freeze({
      preparation: complete ? 'ready' : 'unavailable',
      reason: complete ? undefined : 'installation-failed',
      installation: Object.freeze({ kind: complete ? 'added' : policies.length > 0 ? 'partly-added' : 'failed', serialized, policies: serializedPolicies, source }),
      additions: policies.length > 0 ? Object.freeze([...snapshot.additions, addition]) : snapshot.additions,
      diagnostics: applied === undefined ? 'unavailable' : 'complete',
      privacyBroker: policies.length > 0 ? brokerAwaitingNewAddition() : snapshot.privacyBroker,
    });
    notify();
  }

  async function install({ serialized, source, isCurrent, isRecoveryResident }: {
    serialized: string,
    source: 'saved-setting' | 'developer-action',
    isCurrent(): boolean,
    isRecoveryResident(): boolean,
  }): Promise<void> {
    try {
      const existing = successfulValues.get(serialized);
      if (existing !== undefined) {
        snapshot = Object.freeze({ ...snapshot, preparation: existing.complete ? 'ready' : 'unavailable', reason: existing.complete ? undefined : 'installation-failed', installation: Object.freeze({ kind: existing.complete ? 'added' : 'partly-added', ...existing.addition }) });
        notify();
        return;
      }
      if (latestFailure === serialized) {
        unavailable({ reason: 'invalid-policy' });
        return;
      }
      if (!isRecoveryResident()) {
        unavailable({ reason: 'recovery-not-resident' });
        return;
      }
      if (!isCurrent()) {
        unavailable({ reason: 'setting-changed' });
        return;
      }
      snapshot = Object.freeze({ ...snapshot, preparation: 'preparing', reason: undefined });
      notify();
      const parser = await prepareParser();
      if (parser === undefined) {
        parserLoading = undefined;
        unavailable({ reason: 'parser-unavailable' });
        return;
      }
      if (!isRecoveryResident()) {
        unavailable({ reason: 'recovery-not-resident' });
        return;
      }
      if (!isCurrent()) {
        unavailable({ reason: 'setting-changed' });
        return;
      }
      // Retain only the latest deterministic parse failure. Temporary module
      // failures and earlier failed values do not become permanent history.
      latestFailure = undefined;
      const result = parser({ serialized });
      switch (result.kind) {
      case 'failed': latestFailure = serialized;
        unavailable({ reason: 'invalid-policy' });
        return;
      case 'parsed': {
        const policies: ParsedCspPolicy[] = [];
        let pending: { element: HTMLMetaElement, policy: ParsedCspPolicy } | undefined;
        // This is late development instrumentation, never a security feature.
        // Existing enforced policies cannot be revoked in the current Document.
        // Only this API's successful additions are tracked; external DOM edits
        // and policies inserted from DevTools are deliberately outside its scope.
        try {
          for (const policy of result.value.policies) {
            if (policy.serialized.trim() === '') {
              continue;
            }
            const element = environment.document.createElement('meta');
            element.setAttribute('data-naidan-developer-csp', '');
            element.httpEquiv = 'Content-Security-Policy';
            element.content = policy.serialized;
            pending = { element, policy };
            environment.document.head.append(element);
            policies.push(policy);
            pending = undefined;
          }
          if (policies.length === 0) {
            snapshot = Object.freeze({ ...snapshot, preparation: 'ready', reason: undefined });
            notify();
            return;
          }
          record({ serialized, policies, parsed: result.value, source, complete: true, uncertain: false });
        } catch {
          let uncertain = false;
          try {
            if (pending !== undefined && pending.element.parentNode === environment.document.head) {
              policies.push(pending.policy);
            }
          } catch {
            uncertain = true;
          }
          record({ serialized, policies, parsed: result.value, source, complete: false, uncertain });
        }
        return;
      }
      default: {
        const exhaustive: never = result;
        throw exhaustive;
      }
      }
    } catch {
      unavailable({ reason: 'parser-unavailable' });
    }
  }

  return {
    getSnapshot(): DevelopmentMetaCspSnapshotNotForSecurity {
      return snapshot;
    },
    getAppliedForDocumentMessagesOnly(): readonly AppliedDevelopmentMetaCspForDocumentMessagesOnly[] | undefined {
      return applied;
    },
    getPrivacyBrokerForNextRequestHintsOnly(): Readonly<{ lifetime: 'not-created' | 'ready', basis: 'next-broker' | 'confirmed-current-broker' | 'unconfirmed-current-broker', metas: readonly AppliedDevelopmentMetaCspForUiMessagesOnly[] | undefined }> {
      const broker = snapshot.privacyBroker;
      switch (broker.kind) {
      case 'not-created':
        // Only policies already appended in the main Document are planned for
        // the next broker. Neither the saved setting nor an editor is read.
        return Object.freeze({ lifetime: 'not-created', basis: 'next-broker', metas: applied });
      case 'confirmed': return Object.freeze({ lifetime: 'ready', basis: 'confirmed-current-broker', metas: applied });
      case 'pending':
      case 'unavailable': return Object.freeze({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: policyCount === 0 ? Object.freeze([]) : undefined });
      default: {
        const exhaustive: never = broker.kind;
        return exhaustive;
      }
      }
    },
    getSuccessfulPolicies(): readonly string[] {
      return Object.freeze(snapshot.additions.flatMap(addition => addition.policies));
    },
    subscribeSuccessfulAdditions({ listener }: { listener(): void }): (() => void) | undefined {
      if (listeners.size >= 512) {
        return undefined;
      }
      let additions = snapshot.additions;
      const onChange = () => {
        if (snapshot.additions !== additions) {
          additions = snapshot.additions;
          listener();
        }
      };
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    beginSession({ sessionId }: { sessionId: string }): void {
      if (sessionId.length === 0 || sessionId.length > 128) {
        return;
      }
      snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ kind: policyCount === 0 ? 'confirmed' : 'pending', sessionId, syncId: undefined, requestedPolicyCount: policyCount, confirmedPolicyCount: 0, reason: undefined }) });
      notify();
    },
    recordSending({ sessionId, syncId, policyCount: sentCount }: { sessionId: string, syncId: string, policyCount: number }): void {
      if (snapshot.privacyBroker.sessionId !== sessionId) {
        return;
      }
      const valid = syncId.length > 0 && syncId.length <= 128 && Number.isSafeInteger(sentCount) && sentCount === policyCount;
      snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ ...snapshot.privacyBroker, kind: valid ? 'pending' : 'unavailable', syncId: valid ? syncId : undefined, requestedPolicyCount: policyCount, reason: valid ? undefined : 'invalid-result' }) });
      notify();
    },
    recordSendFailure({ sessionId, syncId }: { sessionId: string, syncId: string }): void {
      if (snapshot.privacyBroker.sessionId !== sessionId || syncId.length === 0 || syncId.length > 128 || (snapshot.privacyBroker.syncId !== undefined && snapshot.privacyBroker.syncId !== syncId)) {
        return;
      }
      snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ ...snapshot.privacyBroker, kind: 'unavailable', syncId, reason: 'send-failed' }) });
      notify();
    },
    recordResult({ sessionId, syncId, confirmedPolicyCount, outcome }: { sessionId: string, syncId: string, confirmedPolicyCount: number, outcome: 'added' | 'partly-added' | 'unavailable' }): void {
      const broker = snapshot.privacyBroker;
      if (broker.sessionId !== sessionId || broker.syncId !== syncId) {
        return;
      }
      if (!Number.isSafeInteger(confirmedPolicyCount) || confirmedPolicyCount < broker.confirmedPolicyCount || confirmedPolicyCount > broker.requestedPolicyCount) {
        snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ ...broker, kind: 'unavailable', reason: 'invalid-result' }) });
      } else {
        switch (outcome) {
        case 'added':
          snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ ...broker, kind: confirmedPolicyCount === policyCount && confirmedPolicyCount === broker.requestedPolicyCount ? 'confirmed' : 'unavailable', confirmedPolicyCount, reason: confirmedPolicyCount === policyCount && confirmedPolicyCount === broker.requestedPolicyCount ? undefined : 'invalid-result' }) });
          break;
        case 'partly-added':
        case 'unavailable':
          snapshot = Object.freeze({ ...snapshot, privacyBroker: Object.freeze({ ...broker, kind: 'unavailable', confirmedPolicyCount, reason: 'installation-failed' }) });
          break;
        default: {
          const exhaustive: never = outcome;
          throw exhaustive;
        }
        }
      }
      notify();
    },
    disposeSession({ sessionId }: { sessionId: string }): void {
      if (snapshot.privacyBroker.sessionId !== sessionId) {
        return;
      }
      snapshot = Object.freeze({ ...snapshot, privacyBroker: absentPrivacyBroker() });
      notify();
    },
    subscribe({ listener }: { listener(): void }): (() => void) | undefined {
      if (listeners.size >= 512) {
        return undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addForDevelopmentNotForSecurity({ serialized, source, isCurrent, isRecoveryResident }: {
      serialized: string | undefined,
      source: 'saved-setting' | 'developer-action',
      isCurrent(): boolean,
      isRecoveryResident(): boolean,
    }): Promise<void> {
      if (serialized === undefined) {
        return Promise.resolve();
      }
      if (serialized.length > 65_536) {
        unavailable({ reason: 'invalid-policy' });
        return Promise.resolve();
      }
      if (serialized.trim() === '') {
        return Promise.resolve();
      }
      const addition = tail.then(() => install({ serialized, source, isCurrent, isRecoveryResident }));
      tail = addition.catch(() => undefined);
      return addition;
    },
  };
}

let owner: ReturnType<typeof createDevelopmentMetaCspOwnerNotForSecurity> | undefined;

function getOwner(): ReturnType<typeof createDevelopmentMetaCspOwnerNotForSecurity> {
  owner ??= createDevelopmentMetaCspOwnerNotForSecurity({ environment: { document, loadParser: () => import('@/utils/csp').then(module => module.parseCsp, () => undefined) } });
  return owner;
}

export function getDevelopmentMetaCspOwnerNotForSecurity() {
  const native = getOwner();
  return Object.freeze({ getSnapshot: native.getSnapshot, subscribe: native.subscribe, addForDevelopmentNotForSecurity: native.addForDevelopmentNotForSecurity });
}

export function getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly() {
  const native = getOwner();
  return Object.freeze({ getAppliedForDocumentMessagesOnly: native.getAppliedForDocumentMessagesOnly, getPrivacyBrokerForNextRequestHintsOnly: native.getPrivacyBrokerForNextRequestHintsOnly, subscribe: native.subscribe });
}

export function getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity() {
  const native = getOwner();
  return Object.freeze({ beginSession: native.beginSession, getSuccessfulPolicies: native.getSuccessfulPolicies, subscribeSuccessfulAdditions: native.subscribeSuccessfulAdditions, recordSending: native.recordSending, recordSendFailure: native.recordSendFailure, recordResult: native.recordResult, disposeSession: native.disposeSession });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
