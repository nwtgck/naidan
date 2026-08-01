import {
  decodeNativePlainTransitionTargetCheckpoint,
  encodeNativePlainTransitionTargetCheckpoint,
  encodePersistenceEndpoint,
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
  type NativePlainTransitionTargetLifecycle,
  type TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  type AuthenticatedTransitionProgressBinding,
  type AuthenticatedTransitionProgressSnapshot,
  AuthenticatedTransitionProgressCompanion,
} from '@/00-storage/service/naidan-persistence-control/transition/authenticated-transition-progress-companion';
import { createTransitionNamespaceCopyCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import {
  type TransitionProgressPort,
  type TransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import {
  decodeTransitionRuntimeProgress,
  encodeTransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-runtime-progress-codec';

const UINT64_MAXIMUM = (1n << 64n) - 1n;
const NATIVE_PLAIN_CODEC = NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.providerCheckpointCodecs.nativePlain;
type CompanionPort = Pick<AuthenticatedTransitionProgressCompanion, 'clear' | 'load' | 'publish'>;

type LoadedState = Readonly<{
  lifecycle: NativePlainTransitionTargetLifecycle;
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

function providerState({ lifecycle }: {
  lifecycle: NativePlainTransitionTargetLifecycle;
}): 'active' | 'sealed' {
  switch (lifecycle) {
  case 'preparing':
  case 'active': return 'active';
  case 'sealed':
  case 'published': return 'sealed';
  default: return lifecycle satisfies never;
  }
}

function canAdvanceLifecycle({ current, next }: {
  current: NativePlainTransitionTargetLifecycle;
  next: NativePlainTransitionTargetLifecycle;
}): boolean {
  switch (current) {
  case 'preparing': return next === 'preparing' || next === 'active' || next === 'sealed';
  case 'active': return next === 'active' || next === 'sealed';
  case 'sealed': return next === 'sealed' || next === 'published';
  case 'published': return next === 'published';
  default: return current satisfies never;
  }
}

function decodeSnapshot({ binding, snapshot }: {
  binding: AuthenticatedTransitionProgressBinding;
  snapshot: AuthenticatedTransitionProgressSnapshot;
}): LoadedState {
  if (snapshot.providerCheckpointCodec !== NATIVE_PLAIN_CODEC) {
    throw new TypeError('native plain transition progress uses another provider checkpoint codec');
  }
  const progress = decodeTransitionRuntimeProgress({ bytes: snapshot.portableProgressBytes });
  if (!sameEndpointIdentity({ binding, progress })) {
    throw new TypeError('portable transition progress belongs to another authority or endpoint binding');
  }
  const checkpoint = decodeNativePlainTransitionTargetCheckpoint({ bytes: snapshot.providerCheckpointBytes });
  if (snapshot.providerCheckpointState !== providerState({ lifecycle: checkpoint.lifecycle })) {
    throw new TypeError('native plain transition target lifecycle disagrees with its checkpoint state');
  }
  return { lifecycle: checkpoint.lifecycle, progress, snapshot };
}

function initialProgress({ binding }: {
  binding: AuthenticatedTransitionProgressBinding;
}): TransitionRuntimeProgress {
  return {
    copyCursor: createTransitionNamespaceCopyCursor(),
    operationId: binding.operationId,
    source: structuredClone(binding.sourceEndpoint),
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'copying',
    target: structuredClone(binding.targetEndpoint),
  };
}

/**
 * Binds the native plain target lifecycle marker and portable cursor to one
 * authenticated companion generation. Directory existence is never treated as
 * ownership: first preparation publishes `preparing`, exact resume reuses the
 * authenticated marker, and target mutations stage lifecycle changes until
 * the coordinator saves its matching portable cursor.
 */
export class NativePlainTransitionProgressBridge {
  readonly #binding: AuthenticatedTransitionProgressBinding;
  readonly #companion: CompanionPort;
  #loaded = false;
  #state: LoadedState | undefined;
  #stagedLifecycle: NativePlainTransitionTargetLifecycle | undefined;

  public constructor({ binding, companion }: {
    binding: AuthenticatedTransitionProgressBinding;
    companion: CompanionPort;
  }) {
    if (binding.providerCheckpointCodec !== NATIVE_PLAIN_CODEC) {
      throw new TypeError('native plain transition bridge requires the native plain provider checkpoint codec');
    }
    this.#binding = structuredClone(binding);
    this.#companion = companion;
  }

  async #load(): Promise<LoadedState | undefined> {
    if (this.#loaded) return this.#state;
    const snapshot = await this.#companion.load();
    this.#state = snapshot === undefined ? undefined : decodeSnapshot({ binding: this.#binding, snapshot });
    this.#loaded = true;
    return this.#state;
  }

  async #publish({ expectedGeneration, lifecycle, progress }: {
    expectedGeneration: bigint | undefined;
    lifecycle: NativePlainTransitionTargetLifecycle;
    progress: TransitionRuntimeProgress;
  }): Promise<LoadedState> {
    if (expectedGeneration === UINT64_MAXIMUM) throw new RangeError('transition-progress generation is exhausted');
    const journalGeneration = (expectedGeneration ?? -1n) + 1n;
    const published = await this.#companion.publish({
      expectedJournalGeneration: expectedGeneration,
      progress: {
        journalGeneration,
        portableProgressBytes: encodeTransitionRuntimeProgress({ progress }),
        providerCheckpointBytes: encodeNativePlainTransitionTargetCheckpoint({ checkpoint: { lifecycle } }),
        providerCheckpointState: providerState({ lifecycle }),
      },
    });
    const state = decodeSnapshot({ binding: this.#binding, snapshot: published });
    this.#state = state;
    this.#loaded = true;
    this.#stagedLifecycle = undefined;
    return state;
  }

  public async prepareTarget(): Promise<NativePlainTransitionTargetLifecycle> {
    const current = await this.#load();
    if (current !== undefined) return current.lifecycle;
    const created = await this.#publish({
      expectedGeneration: undefined,
      lifecycle: 'preparing',
      progress: initialProgress({ binding: this.#binding }),
    });
    return created.lifecycle;
  }

  public async stageLifecycle({ lifecycle }: {
    lifecycle: NativePlainTransitionTargetLifecycle;
  }): Promise<void> {
    const current = await this.#load();
    if (current === undefined) throw new TypeError('native plain transition target must be prepared before staging lifecycle');
    const effective = this.#stagedLifecycle ?? current.lifecycle;
    if (!canAdvanceLifecycle({ current: effective, next: lifecycle })) {
      throw new TypeError(`native plain transition target cannot move from ${effective} to ${lifecycle}`);
    }
    this.#stagedLifecycle = lifecycle;
  }

  public async currentLifecycle(): Promise<NativePlainTransitionTargetLifecycle | undefined> {
    return (await this.#load())?.lifecycle;
  }

  readonly progressPort: TransitionProgressPort = {
    clear: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      const current = await this.#load();
      if (current === undefined) return;
      const effective = this.#stagedLifecycle ?? current.lifecycle;
      switch (effective) {
      case 'sealed':
        await this.#publish({
          expectedGeneration: current.snapshot.journalGeneration,
          lifecycle: 'published',
          progress: current.progress,
        });
        return;
      case 'preparing':
      case 'active':
      case 'published':
        await this.#companion.clear({ expectedJournalGeneration: current.snapshot.journalGeneration });
        this.#state = undefined;
        this.#loaded = true;
        this.#stagedLifecycle = undefined;
        return;
      default: effective satisfies never;
      }
    },
    load: async ({ operationId }) => {
      this.#requireOperation({ operationId });
      return structuredClone((await this.#load())?.progress);
    },
    save: async ({ progress }) => {
      if (!sameEndpointIdentity({ binding: this.#binding, progress })) {
        throw new TypeError('cannot save portable progress for another transition binding');
      }
      const current = await this.#load();
      if (current === undefined) {
        throw new TypeError('native plain transition target must be prepared before saving progress');
      }
      const lifecycle = this.#stagedLifecycle ?? current.lifecycle;
      await this.#publish({
        expectedGeneration: current.snapshot.journalGeneration,
        lifecycle,
        progress,
      });
    },
  };

  #requireOperation({ operationId }: { operationId: TransitionOperationId | string }): void {
    if (operationId !== this.#binding.operationId) {
      throw new TypeError('native plain transition bridge belongs to another operation');
    }
  }
}

export const TEST_ONLY = {
  canAdvanceLifecycle,
  decodeSnapshot,
  initialProgress,
  providerState,
  sameEndpointIdentity,
};
