import { getAppliedDevelopmentMetaCspForDocumentMessagesOnly, getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly, subscribeDevelopmentMetaCspMessagesOnly } from '@/logic/development-meta-csp/document-messages-only';
import { appendReferenceDeploymentSuggestionsForUiOnly, describeCspAndDevelopmentMetaForUiMessagesOnly, getCspTargetMemoKeyForMessagesOnly, summarizeCspConnectionsForDisplayOnly } from './messages';
import { getCspObservationOwnerForMessagesOnly } from './observation';
import type { CspDeveloperSnapshot, CspHintDetail, CspHintMessage, CspHintTarget } from './types';

const owner = getCspObservationOwnerForMessagesOnly();
const listeners = new Set<() => void>();
const memo = new Map<string, CspHintMessage | undefined>();
let budget = { remaining: 65_536 };
let suggestionBudget = { remaining: 16_384 };

function notify(): void {
  memo.clear();
  budget = { remaining: 65_536 };
  suggestionBudget = { remaining: 16_384 };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Hint consumers cannot turn diagnostic updates into application errors.
    }
  }
}

const observationSubscription = owner.subscribe({ listener: notify });
const developmentMetaSubscription = subscribeDevelopmentMetaCspMessagesOnly({ listener: notify });

/** Messages only: never use this output to control any feature operation. */
export function describeCspForUiMessagesOnly({ target }: { target: CspHintTarget | undefined }): CspHintMessage | undefined {
  try {
    if (observationSubscription === undefined || developmentMetaSubscription === undefined) {
      return undefined;
    }
    const documentMetas = getAppliedDevelopmentMetaCspForDocumentMessagesOnly();
    if (documentMetas === undefined) {
      return undefined;
    }
    const key = getCspTargetMemoKeyForMessagesOnly({ target });
    if (key === undefined) {
      return undefined;
    }
    if (memo.has(key)) {
      return memo.get(key);
    }
    if (memo.size >= 128) {
      return undefined;
    }
    const observation = owner.getSnapshot();
    const privacyBroker = getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly();
    const message = describeCspAndDevelopmentMetaForUiMessagesOnly({ observation, documentMetas, privacyBroker, target, broker: __BUILD_MODE_IS_STANDALONE__ ? 'absent' : 'hosted', budget });
    const displayed = message === undefined ? undefined : appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: suggestionBudget });
    memo.set(key, displayed);
    return displayed;
  } catch {
    return undefined;
  }
}

export function subscribeCspMessagesOnly({ listener }: { listener: () => void }): (() => void) | undefined {
  if (observationSubscription === undefined || developmentMetaSubscription === undefined || listeners.size >= 512) {
    return undefined;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function ensureCspObservationForMessagesOnly(): Promise<void> {
  return owner.ensure().then(() => undefined);
}

/** The sole raw snapshot exit is the explicitly technical Developer display. */
export function getCspDeveloperSnapshotForDisplayOnly(): CspDeveloperSnapshot {
  const observation = owner.getSnapshot();
  const documentMetas = getAppliedDevelopmentMetaCspForDocumentMessagesOnly();
  let connectionSummary: readonly CspHintDetail[] | undefined;
  if (documentMetas !== undefined) {
    const rows: CspHintDetail[] = [];
    let complete = true;
    switch (observation.kind) {
    case 'observed': rows.push(...(summarizeCspConnectionsForDisplayOnly({ parsed: observation.enforce?.parsed }) ?? []));
      break;
    case 'not-started':
    case 'pending':
    case 'unavailable': break;
    default: {
      const exhaustive: never = observation;
      throw exhaustive;
    }
    }
    for (const meta of documentMetas) {
      const summary = summarizeCspConnectionsForDisplayOnly({ parsed: meta.parsed });
      if (summary === undefined) {
        complete = false;
        break;
      }
      rows.push(...summary);
      if (rows.length > 64) {
        complete = false;
        break;
      }
    }
    connectionSummary = complete && rows.length > 0 ? Object.freeze(rows) : undefined;
  }
  return Object.freeze({ observation, addedMetaParsed: documentMetas === undefined ? undefined : Object.freeze(documentMetas.map(meta => meta.parsed)), connectionSummary });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
