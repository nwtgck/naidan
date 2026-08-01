import {
  selectPersistenceControlAuthority,
  type PersistenceControlCandidate,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  publishPersistenceControl,
  readPersistenceControlCandidates,
  type PersistenceControlPhysicalPort,
  type PersistenceControlProofAuthority,
  type PersistenceControlSemanticState,
} from '@/00-storage/service/naidan-persistence-control/store';
import type { PersistenceControlRandomSource } from '@/00-storage/service/naidan-persistence-control/crypto';
import type {
  TransitionControlPort,
  TransitionSemanticState,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';

function bothPersistenceControlCopiesAreMissing({ candidates }: {
  candidates: readonly [PersistenceControlCandidate, PersistenceControlCandidate];
}): boolean {
  return candidates.every(candidate => candidate.state === 'structurally_invalid' && candidate.reason === 'missing');
}

/**
 * Creates one transition-scoped Persistence Control port.
 *
 * The one-shot bootstrap authorization is valid only after the caller has
 * independently verified a stable plain namespace. It permits exactly the
 * initial state read and first A/B publication when both control copies are
 * absent. Any selected, partial, corrupt, or proof-bearing control state
 * permanently disables bootstrap for this port instance.
 */
export function createPersistenceControlTransitionPort({
  bootstrapAuthorization,
  physical,
  proofAuthority,
  randomSource,
}: {
  bootstrapAuthorization: 'verified_plain_namespace' | undefined;
  physical: PersistenceControlPhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
  randomSource: PersistenceControlRandomSource | undefined;
}): TransitionControlPort {
  let bootstrapAvailable = bootstrapAuthorization === 'verified_plain_namespace';

  return {
    publishState: async ({ state }) => {
      if (bootstrapAvailable) {
        const before = await readPersistenceControlCandidates({ physical, proofAuthority });
        if (!bothPersistenceControlCopiesAreMissing({ candidates: before.candidates })) {
          bootstrapAvailable = false;
        }
      }
      await publishPersistenceControl({
        bootstrapAuthorization: bootstrapAvailable ? 'verified_plain_namespace' : undefined,
        physical,
        proofAuthority,
        randomSource,
        semanticState: state satisfies PersistenceControlSemanticState,
      });
      bootstrapAvailable = false;
    },
    readState: async (): Promise<TransitionSemanticState> => {
      const read = await readPersistenceControlCandidates({ physical, proofAuthority });
      try {
        const selected = selectPersistenceControlAuthority({ candidates: read.candidates });
        bootstrapAvailable = false;
        return {
          mode: selected.control.mode,
          retiredFileSystemIds: selected.control.retiredFileSystemIds,
        };
      } catch (cause: unknown) {
        if (bootstrapAvailable && bothPersistenceControlCopiesAreMissing({ candidates: read.candidates })) {
          return { mode: { type: 'plain' }, retiredFileSystemIds: [] };
        }
        bootstrapAvailable = false;
        throw cause;
      }
    },
  };
}

export const TEST_ONLY = {
  bothPersistenceControlCopiesAreMissing,
};
