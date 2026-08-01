import type {
  HizoFSTransitionImportJournalBinding,
  HizoFSTransitionImportJournalPort,
  HizoFSTransitionImportJournalRecord,
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

function sameProgressBinding({ binding, progress }: {
  binding: RuntimeTransitionBinding;
  progress: TransitionRuntimeProgress;
}): boolean {
  return progress.operationId === binding.operationId
    && progress.sourceAuthorityIdentity === binding.sourceAuthorityIdentity
    && sameRuntimeTransitionEndpoint({ left: progress.source, right: binding.sourceEndpoint })
    && sameRuntimeTransitionEndpoint({ left: progress.target, right: binding.targetEndpoint });
}

function sameJournalBinding({ left, right }: {
  left: HizoFSTransitionImportJournalBinding;
  right: HizoFSTransitionImportJournalBinding;
}): boolean {
  return left.operationIdentity === right.operationIdentity
    && left.sourceAuthorityIdentity === right.sourceAuthorityIdentity
    && left.sourceEndpointIdentity === right.sourceEndpointIdentity
    && left.targetAuthorityIdentity === right.targetAuthorityIdentity
    && left.targetEndpointIdentity === right.targetEndpointIdentity;
}

/**
 * Keeps bounded transition work only for one live transition invocation.
 * Losing this object deliberately loses all copy and private-import progress.
 */
export class RuntimeHizoFSTransitionProgress {
  readonly #binding: RuntimeTransitionBinding;
  readonly #journalBinding: HizoFSTransitionImportJournalBinding;
  #progress: TransitionRuntimeProgress | undefined;
  #providerRecord: HizoFSTransitionImportJournalRecord | undefined;
  #stagedProviderRecord: HizoFSTransitionImportJournalRecord | undefined;

  public constructor({ binding, journalBinding }: {
    binding: RuntimeTransitionBinding;
    journalBinding: HizoFSTransitionImportJournalBinding;
  }) {
    if (binding.operationId !== journalBinding.operationIdentity
      || binding.sourceAuthorityIdentity !== journalBinding.sourceAuthorityIdentity
      || binding.targetAuthorityIdentity !== journalBinding.targetAuthorityIdentity) {
      throw new TypeError('runtime HizoFS progress binding disagrees with its provider journal binding');
    }
    this.#binding = structuredClone(binding);
    this.#journalBinding = structuredClone(journalBinding);
  }

  readonly progressPort: TransitionProgressPort = {
    clear: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      this.#progress = undefined;
      this.#providerRecord = undefined;
      this.#stagedProviderRecord = undefined;
    },
    load: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      return structuredClone(this.#progress);
    },
    save: async ({ progress }) => {
      if (!sameProgressBinding({ binding: this.#binding, progress })) {
        throw new TypeError('cannot save runtime progress for another transition binding');
      }
      const staged = this.#stagedProviderRecord;
      if (staged !== undefined) {
        this.#providerRecord = structuredClone(staged);
        this.#stagedProviderRecord = undefined;
      }
      if (this.#providerRecord === undefined) {
        throw new TypeError('runtime progress cannot advance before the target checkpoint is staged');
      }
      this.#progress = structuredClone(progress);
    },
  };

  readonly providerJournalPort: HizoFSTransitionImportJournalPort = {
    clear: async ({ binding, expectedGeneration }) => {
      this.#requireJournalBinding({ binding });
      const record = this.#providerRecord;
      if (record === undefined) return;
      if (record.generation !== expectedGeneration) {
        throw new TypeError('runtime provider checkpoint clear generation compare-and-swap failed');
      }
      this.#providerRecord = undefined;
      this.#stagedProviderRecord = undefined;
    },
    load: async ({ operationIdentity }) => {
      this.#requireOperation({ operationId: operationIdentity });
      return structuredClone(this.#providerRecord);
    },
    publish: async ({ expectedGeneration, record }) => {
      this.#requireJournalBinding({ binding: record.binding });
      const actualGeneration = this.#providerRecord?.generation;
      if (actualGeneration !== expectedGeneration) {
        throw new TypeError('runtime provider checkpoint generation compare-and-swap failed');
      }
      const nextGeneration = (actualGeneration ?? -1n) + 1n;
      if (record.generation !== nextGeneration) {
        throw new TypeError('runtime provider checkpoint must advance its generation exactly once');
      }
      this.#stagedProviderRecord = structuredClone(record);
    },
  };

  #requireJournalBinding({ binding }: {
    binding: HizoFSTransitionImportJournalBinding;
  }): void {
    if (!sameJournalBinding({ left: binding, right: this.#journalBinding })) {
      throw new TypeError('runtime HizoFS checkpoint belongs to another transition binding');
    }
  }

  #requireOperation({ operationId }: {
    operationId: TransitionOperationId | string;
  }): void {
    if (operationId !== this.#binding.operationId) {
      throw new TypeError('runtime HizoFS progress belongs to another operation');
    }
  }
}

export const TEST_ONLY = {
  sameJournalBinding,
  sameProgressBinding,
};
