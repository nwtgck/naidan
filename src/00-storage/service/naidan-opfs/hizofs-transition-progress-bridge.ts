import {
  createHizoFSTransitionImportJournalPort,
  type HizoFSTransitionImportCheckpointSnapshot,
  type HizoFSTransitionImportJournalBinding,
  type HizoFSTransitionImportJournalPort,
} from "@/00-storage/service/hizofs/api";
import { encodePersistenceEndpoint, type TransitionOperationId } from "@/00-storage/service/naidan-persistence-control/00-format";
import {
  type AuthenticatedTransitionProgressBinding,
  type AuthenticatedTransitionProgressSnapshot,
  AuthenticatedTransitionProgressCompanion,
} from "@/00-storage/service/naidan-persistence-control/transition/authenticated-transition-progress-companion";
import {
  decodeTransitionRuntimeProgress,
  encodeTransitionRuntimeProgress,
} from "@/00-storage/service/naidan-persistence-control/transition/transition-runtime-progress-codec";
import type {
  TransitionProgressPort,
  TransitionRuntimeProgress,
} from "@/00-storage/service/naidan-persistence-control/transition/transition-coordinator";

const UINT64_MAXIMUM = (1n << 64n) - 1n;

type CompanionPort = Pick<AuthenticatedTransitionProgressCompanion, "clear" | "load" | "publish">;

type LoadedState = Readonly<{
  progress: TransitionRuntimeProgress;
  snapshot: AuthenticatedTransitionProgressSnapshot;
}>;

function sameEndpointIdentity({ binding, progress }: {
  binding: AuthenticatedTransitionProgressBinding;
  progress: TransitionRuntimeProgress;
}): boolean {
  return progress.operationId === binding.operationId
    && progress.sourceAuthorityIdentity === binding.sourceAuthorityIdentity
    && encodePersistenceEndpoint({ endpoint: progress.source }) === encodePersistenceEndpoint({ endpoint: binding.sourceEndpoint })
    && encodePersistenceEndpoint({ endpoint: progress.target }) === encodePersistenceEndpoint({ endpoint: binding.targetEndpoint });
}

function journalBinding({ binding }: {
  binding: AuthenticatedTransitionProgressBinding;
}): HizoFSTransitionImportJournalBinding {
  return {
    operationIdentity: binding.operationId,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    sourceEndpointIdentity: encodePersistenceEndpoint({ endpoint: binding.sourceEndpoint }),
    targetAuthorityIdentity: binding.targetAuthorityIdentity,
    targetEndpointIdentity: encodePersistenceEndpoint({ endpoint: binding.targetEndpoint }),
  };
}


function decodeSnapshot({ binding, snapshot }: {
  binding: AuthenticatedTransitionProgressBinding;
  snapshot: AuthenticatedTransitionProgressSnapshot;
}): LoadedState {
  const progress = decodeTransitionRuntimeProgress({ bytes: snapshot.portableProgressBytes });
  if (!sameEndpointIdentity({ binding, progress })) {
    throw new TypeError("portable transition progress belongs to another authority or endpoint binding");
  }
  return { progress, snapshot };
}

/**
 * Joins portable transition progress and the private HizoFS import checkpoint
 * into one authenticated companion generation. Provider writes are staged in
 * memory until the coordinator has closed both endpoint sessions; the later
 * portable-progress save publishes both values atomically. A crash before that
 * publication therefore replays the previous cursor/checkpoint pair instead of
 * accepting a cursor that is ahead of durable private state.
 */
export class HizoFSTransitionProgressBridge {
  readonly #binding: AuthenticatedTransitionProgressBinding;
  readonly #companion: CompanionPort;
  readonly #journalBinding: HizoFSTransitionImportJournalBinding;
  #loaded = false;
  #state: LoadedState | undefined;
  #stagedProviderCheckpoint: HizoFSTransitionImportCheckpointSnapshot | undefined;

  public constructor({ binding, companion }: {
    binding: AuthenticatedTransitionProgressBinding;
    companion: CompanionPort;
  }) {
    this.#binding = structuredClone(binding);
    this.#companion = companion;
    this.#journalBinding = journalBinding({ binding });
    this.providerJournalPort = createHizoFSTransitionImportJournalPort({
      binding: this.#journalBinding,
      stagingPort: {
        clear: async ({ expectedGeneration }) => {
          const state = await this.#load();
          if (state === undefined) return;
          if (state.snapshot.journalGeneration !== expectedGeneration) {
            throw new TypeError("provider checkpoint clear generation compare-and-swap failed");
          }
          await this.#companion.clear({ expectedJournalGeneration: expectedGeneration });
          this.#state = undefined;
          this.#stagedProviderCheckpoint = undefined;
          this.#loaded = true;
        },
        load: async () => {
          const state = await this.#load();
          if (state === undefined) return undefined;
          return {
            bytes: state.snapshot.providerCheckpointBytes.slice(),
            generation: state.snapshot.journalGeneration,
            state: state.snapshot.providerCheckpointState,
          };
        },
        stage: async ({ expectedGeneration, snapshot }) => {
          const state = await this.#load();
          const actualGeneration = state?.snapshot.journalGeneration;
          if (actualGeneration !== expectedGeneration) {
            throw new TypeError("provider checkpoint generation compare-and-swap failed");
          }
          const nextGeneration = (actualGeneration ?? -1n) + 1n;
          if (snapshot.generation !== nextGeneration) {
            throw new TypeError("provider checkpoint must advance the companion generation exactly once");
          }
          this.#stagedProviderCheckpoint = {
            bytes: snapshot.bytes.slice(),
            generation: snapshot.generation,
            state: snapshot.state,
          };
        },
      },
    });
  }

  async #load(): Promise<LoadedState | undefined> {
    if (this.#loaded) return this.#state;
    const snapshot = await this.#companion.load();
    this.#state = snapshot === undefined ? undefined : decodeSnapshot({ binding: this.#binding, snapshot });
    this.#loaded = true;
    return this.#state;
  }

  readonly progressPort: TransitionProgressPort = {
    clear: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      const state = await this.#load();
      if (state === undefined) return;
      await this.#companion.clear({ expectedJournalGeneration: state.snapshot.journalGeneration });
      this.#state = undefined;
      this.#stagedProviderCheckpoint = undefined;
      this.#loaded = true;
    },
    load: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      return structuredClone((await this.#load())?.progress);
    },
    save: async ({ progress }) => {
      if (!sameEndpointIdentity({ binding: this.#binding, progress })) {
        throw new TypeError("cannot save portable progress for another transition binding");
      }
      const current = await this.#load();
      const expectedGeneration = current?.snapshot.journalGeneration;
      if (expectedGeneration === UINT64_MAXIMUM) throw new RangeError("transition-progress generation is exhausted");
      const nextGeneration = (expectedGeneration ?? -1n) + 1n;
      const staged = this.#stagedProviderCheckpoint;
      if (staged !== undefined && staged.generation !== nextGeneration) {
        throw new TypeError("staged provider checkpoint does not match the next companion generation");
      }
      const checkpointBytes = staged?.bytes ?? current?.snapshot.providerCheckpointBytes;
      const checkpointState = staged?.state ?? current?.snapshot.providerCheckpointState;
      if (checkpointBytes === undefined || checkpointState === undefined) {
        throw new TypeError("portable progress cannot advance before the target checkpoint is staged");
      }
      const published = await this.#companion.publish({
        expectedJournalGeneration: expectedGeneration,
        progress: {
          journalGeneration: nextGeneration,
          portableProgressBytes: encodeTransitionRuntimeProgress({ progress }),
          providerCheckpointBytes: checkpointBytes.slice(),
          providerCheckpointState: checkpointState,
        },
      });
      this.#state = decodeSnapshot({ binding: this.#binding, snapshot: published });
      this.#stagedProviderCheckpoint = undefined;
      this.#loaded = true;
    },
  };

  readonly providerJournalPort: HizoFSTransitionImportJournalPort;

  #requireOperation({ operationId }: { operationId: TransitionOperationId | string }): void {
    if (operationId !== this.#binding.operationId) {
      throw new TypeError("transition-progress bridge belongs to another operation");
    }
  }

}

export const TEST_ONLY = {
  decodeSnapshot,
  journalBinding,
  sameEndpointIdentity,
};
