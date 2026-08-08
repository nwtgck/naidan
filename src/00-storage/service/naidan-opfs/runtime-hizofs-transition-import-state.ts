import type {
  HizoFSTransitionImportCandidate,
  HizoFSTransitionImportStatePort,
} from '@/00-storage/service/hizofs/api';
import type { TransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  TransitionProgressPort,
  TransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import {
  type RuntimeTransitionBinding,
  sameRuntimeTransitionEndpoint,
} from './runtime-transition-binding';

type CommittedTransitionImportSlice = Readonly<{
  candidate: HizoFSTransitionImportCandidate;
  progress: TransitionRuntimeProgress;
}>;

function sameProgressBinding({ binding, progress }: {
  binding: RuntimeTransitionBinding;
  progress: TransitionRuntimeProgress;
}): boolean {
  return progress.operationId === binding.operationId
    && progress.sourceAuthorityIdentity === binding.sourceAuthorityIdentity
    && sameRuntimeTransitionEndpoint({ left: progress.source, right: binding.sourceEndpoint })
    && sameRuntimeTransitionEndpoint({ left: progress.target, right: binding.targetEndpoint });
}

function candidateForProgress({ committed, progress, stagedCandidate }: {
  committed: CommittedTransitionImportSlice | undefined;
  progress: TransitionRuntimeProgress;
  stagedCandidate: HizoFSTransitionImportCandidate | undefined;
}): HizoFSTransitionImportCandidate {
  switch (progress.stage) {
  case 'copying': {
    switch (stagedCandidate?.type) {
    case 'active': return stagedCandidate;
    case 'sealed':
    case undefined:
      throw new TypeError('copy progress requires the active candidate produced by the same target slice');
    default: return stagedCandidate satisfies never;
    }
  }
  case 'verifying':
    if (stagedCandidate !== undefined) {
      switch (stagedCandidate.type) {
      case 'sealed': return stagedCandidate;
      case 'active': throw new TypeError('verification progress requires a sealed private target candidate');
      default: return stagedCandidate satisfies never;
      }
    }
    if (committed?.progress.stage !== 'verifying' || committed.candidate.type !== 'sealed') {
      throw new TypeError('verification progress cannot start before the matching private target is sealed');
    }
    return committed.candidate;
  default: return progress satisfies never;
  }
}

/**
 * Owns one HizoFS transition invocation's portable cursor and typed private
 * importer candidate. A target slice stages its candidate first; only the
 * subsequent portable-progress save commits both values as one runtime state.
 * Losing this object deliberately loses every private import checkpoint.
 */
export class RuntimeHizoFSTransitionImportState {
  private readonly binding: RuntimeTransitionBinding;
  private committed: CommittedTransitionImportSlice | undefined;
  private stagedCandidate: HizoFSTransitionImportCandidate | undefined;

  public constructor({ binding }: {
    binding: RuntimeTransitionBinding;
  }) {
    this.binding = structuredClone(binding);
  }

  readonly progressPort: TransitionProgressPort = {
    clear: async ({ operationId }) => {
      this.requireOperation({ operationId });
      this.committed = undefined;
      this.stagedCandidate = undefined;
    },
    load: async ({ operationId }) => {
      this.requireOperation({ operationId });
      return structuredClone(this.committed?.progress);
    },
    save: async ({ progress }) => {
      if (!sameProgressBinding({ binding: this.binding, progress })) {
        throw new TypeError('cannot save runtime progress for another transition binding');
      }
      const candidate = candidateForProgress({
        committed: this.committed,
        progress,
        stagedCandidate: this.stagedCandidate,
      });
      this.committed = {
        candidate,
        progress: structuredClone(progress),
      };
      this.stagedCandidate = undefined;
    },
  };

  readonly importStatePort: HizoFSTransitionImportStatePort = {
    loadCandidate: async ({ operationIdentity }) => {
      this.requireOperation({ operationId: operationIdentity });
      return structuredClone(this.committed?.candidate);
    },
    stageCandidate: async ({ candidate, operationIdentity }) => {
      this.requireOperation({ operationId: operationIdentity });
      if (this.stagedCandidate !== undefined) {
        throw new TypeError('runtime import state already has an uncommitted target slice');
      }
      const current = this.committed?.candidate;
      switch (current?.type) {
      case undefined:
      case 'active': break;
      case 'sealed':
        switch (candidate.type) {
        case 'sealed': break;
        case 'active':
          throw new TypeError('sealed runtime import state cannot return to an active checkpoint');
        default: candidate satisfies never;
        }
        break;
      default: current satisfies never;
      }
      this.stagedCandidate = structuredClone(candidate);
    },
  };

  private requireOperation({ operationId }: {
    operationId: TransitionOperationId | string;
  }): void {
    if (operationId !== this.binding.operationId) {
      throw new TypeError('runtime HizoFS import state belongs to another operation');
    }
  }
}

export const TEST_ONLY = {
  candidateForProgress,
  sameProgressBinding,
};
