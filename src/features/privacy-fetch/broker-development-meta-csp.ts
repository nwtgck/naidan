import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import type { DevelopmentMetaCspResultMessage, DevelopmentMetaCspSyncMessage } from './development-meta-csp-protocol';

export function createBrokerDevelopmentMetaCspNotForSecurity({ documentObject }: {
  documentObject: Document,
}) {
  const confirmedPolicies: string[] = [];
  let uncertain = false;

  return {
    applySnapshot({ message }: { message: DevelopmentMetaCspSyncMessage }): DevelopmentMetaCspResultMessage {
      const result = ({ outcome }: { outcome: DevelopmentMetaCspResultMessage['outcome'] }): DevelopmentMetaCspResultMessage => ({
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'development-meta-csp-result',
        sessionId: message.sessionId,
        syncId: message.syncId,
        confirmedPolicyCount: confirmedPolicies.length,
        outcome,
      });
      // Only append to a verified prefix. A mismatched history cannot revoke
      // meta policies already enforced in this Document or safely replace them.
      if (uncertain || confirmedPolicies.length > message.policies.length || confirmedPolicies.some((policy, index) => policy !== message.policies[index])) {
        return result({ outcome: 'unavailable' });
      }

      let pending: { element: HTMLMetaElement, policy: string } | undefined;
      try {
        for (let index = confirmedPolicies.length; index < message.policies.length; index++) {
          const policy = message.policies[index];
          if (policy === undefined) {
            return result({ outcome: 'unavailable' });
          }
          // Late development instrumentation only: this does not improve
          // security, prevent earlier loads, or reproduce unsupported directives.
          // Never use this record to choose feature permissions or ON/OFF state.
          const element = documentObject.createElement('meta');
          element.setAttribute('data-naidan-developer-csp', '');
          element.httpEquiv = 'Content-Security-Policy';
          element.content = policy;
          pending = { element, policy };
          documentObject.head.append(element);
          confirmedPolicies.push(policy);
          pending = undefined;
        }
        return result({ outcome: 'added' });
      } catch {
        try {
          if (pending !== undefined && pending.element.parentNode === documentObject.head) {
            confirmedPolicies.push(pending.policy);
          }
        } catch {
          // An ambiguous DOM result must not later become confirmed by guessing.
          uncertain = true;
        }
        return result({ outcome: uncertain || confirmedPolicies.length === 0 ? 'unavailable' : 'partly-added' });
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
