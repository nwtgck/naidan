import {
  HizoFSCorruptionError,
  HizoFSPublicationOutcomeUnknownError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import { createHizoFSStableId } from '@/00-storage/service/hizofs/id';
import { z } from 'zod';
import {
  freezeHizoFSActiveState,
  HizoFSActiveStateSchema,
  type HizoFSActiveState,
} from './active-state';
import type { HizoFSRuntimeDiagnostics } from './diagnostics';

const COORDINATOR_PROTOCOL_VERSION = 1 as const;
const COORDINATOR_REQUEST_TIMEOUT_MS = 10_000;
const COORDINATOR_RETRY_INTERVAL_MS = 25;
const COORDINATOR_RESPONSE_RETRY_INTERVAL_MS = 1_000;
const MAXIMUM_REMEMBERED_RESPONSES = 1024;

type HizoFSCoordinatorPublishResult =
  | {
    readonly type: 'retry';
    readonly state: HizoFSActiveState;
  }
  | {
    readonly type: 'published';
    readonly state: HizoFSActiveState;
  };

type HizoFSCoordinatorOperation =
  | { readonly type: 'load_active_state' }
  | {
    readonly type: 'is_current';
    readonly commitObjectId: string;
  }
  | {
    readonly type: 'publish';
    readonly publicationId: string;
    readonly expectedCommitObjectId: string;
    readonly expectedRevision: number;
    readonly inodeIndexRootObjectId: string;
  };

type CoordinatorOperationDelivery =
  | { readonly type: 'local' }
  | {
    readonly type: 'remote';
    readonly previouslyAcknowledgedLeaderId: string | undefined;
  };

type HizoFSCoordinatorOperationResult =
  | {
    readonly type: 'active_state';
    readonly state: HizoFSActiveState;
  }
  | {
    readonly type: 'current_check';
    readonly isCurrent: boolean;
  }
  | {
    readonly type: 'publication';
    readonly publication: HizoFSCoordinatorPublishResult;
  };

type SerializedCoordinatorError = {
  readonly type:
    | 'corruption'
    | 'publication_outcome_unknown'
    | 'unsupported_format'
    | 'error';
  readonly name: string;
  readonly message: string;
};

type CoordinatorRequestMessage = {
  readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
  readonly messageType: 'request';
  readonly requestId: string;
  readonly senderId: string;
  readonly previouslyAcknowledgedLeaderId: string | undefined;
  readonly operation: HizoFSCoordinatorOperation;
};

type CoordinatorResponseMessage = {
  readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
  readonly messageType: 'response';
  readonly requestId: string;
  readonly recipientId: string;
  readonly response:
    | {
      readonly type: 'success';
      readonly result: HizoFSCoordinatorOperationResult;
    }
    | {
      readonly type: 'failure';
      readonly error: SerializedCoordinatorError;
    };
};

type CoordinatorRequestAcknowledgementMessage = {
  readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
  readonly messageType: 'request_acknowledged';
  readonly requestId: string;
  readonly recipientId: string;
  readonly leaderId: string;
};

type CoordinatorLeaderMessage = {
  readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
  readonly messageType: 'leader_ready';
  readonly leaderId: string;
};

type CoordinatorMessage =
  | CoordinatorRequestMessage
  | CoordinatorRequestAcknowledgementMessage
  | CoordinatorResponseMessage
  | CoordinatorLeaderMessage;

const HizoFSCoordinatorOperationSchema: z.ZodType<HizoFSCoordinatorOperation> =
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('load_active_state') }).strict(),
    z.object({
      type: z.literal('is_current'),
      commitObjectId: z.string(),
    }).strict(),
    z.object({
      type: z.literal('publish'),
      publicationId: z.string(),
      expectedCommitObjectId: z.string(),
      expectedRevision: z.number().int().nonnegative(),
      inodeIndexRootObjectId: z.string(),
    }).strict(),
  ]);

const HizoFSCoordinatorPublishResultSchema: z.ZodType<
  HizoFSCoordinatorPublishResult
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('retry'),
    state: HizoFSActiveStateSchema,
  }).strict(),
  z.object({
    type: z.literal('published'),
    state: HizoFSActiveStateSchema,
  }).strict(),
]);

const HizoFSCoordinatorOperationResultSchema: z.ZodType<
  HizoFSCoordinatorOperationResult
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('active_state'),
    state: HizoFSActiveStateSchema,
  }).strict(),
  z.object({
    type: z.literal('current_check'),
    isCurrent: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('publication'),
    publication: HizoFSCoordinatorPublishResultSchema,
  }).strict(),
]);

const SerializedCoordinatorErrorSchema: z.ZodType<SerializedCoordinatorError> =
  z.object({
    type: z.enum([
      'corruption',
      'publication_outcome_unknown',
      'unsupported_format',
      'error',
    ]),
    name: z.string(),
    message: z.string(),
  }).strict();

const CoordinatorMessageSchema: z.ZodType<CoordinatorMessage> =
  z.discriminatedUnion('messageType', [
    z.object({
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      messageType: z.literal('request'),
      requestId: z.string(),
      senderId: z.string(),
      previouslyAcknowledgedLeaderId: z.union([z.string(), z.undefined()]),
      operation: HizoFSCoordinatorOperationSchema,
    }).strict(),
    z.object({
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      messageType: z.literal('request_acknowledged'),
      requestId: z.string(),
      recipientId: z.string(),
      leaderId: z.string(),
    }).strict(),
    z.object({
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      messageType: z.literal('response'),
      requestId: z.string(),
      recipientId: z.string(),
      response: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('success'),
          result: HizoFSCoordinatorOperationResultSchema,
        }).strict(),
        z.object({
          type: z.literal('failure'),
          error: SerializedCoordinatorErrorSchema,
        }).strict(),
      ]),
    }).strict(),
    z.object({
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      messageType: z.literal('leader_ready'),
      leaderId: z.string(),
    }).strict(),
  ]);

type PendingRequest = {
  readonly operation: HizoFSCoordinatorOperation;
  readonly settled: PromiseWithResolvers<HizoFSCoordinatorOperationResult>;
  acknowledgedLeaderId: string | undefined;
  awaitingAcknowledgedResponse: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
};

type RememberedResponse = {
  readonly promise: Promise<CoordinatorResponseMessage['response']>;
  state: 'pending' | 'settled';
};

type LocalCoordinatorGroup = {
  readonly members: Set<HizoFSActiveStateCoordinator>;
  leader: HizoFSActiveStateCoordinator | undefined;
};

const localCoordinatorGroups = new WeakMap<
  object,
  Map<string, LocalCoordinatorGroup>
>();

function getLocalCoordinatorGroup({ localCoordinationIdentity, fileSystemId }: {
  localCoordinationIdentity: object;
  fileSystemId: string;
}): LocalCoordinatorGroup {
  let byFileSystemId = localCoordinatorGroups.get(localCoordinationIdentity);
  if (byFileSystemId === undefined) {
    byFileSystemId = new Map();
    localCoordinatorGroups.set(localCoordinationIdentity, byFileSystemId);
  }
  let group = byFileSystemId.get(fileSystemId);
  if (group === undefined) {
    group = {
      members: new Set(),
      leader: undefined,
    };
    byFileSystemId.set(fileSystemId, group);
  }
  return group;
}

function deleteLocalCoordinatorGroupIfEmpty({
  localCoordinationIdentity,
  fileSystemId,
  group,
}: {
  localCoordinationIdentity: object;
  fileSystemId: string;
  group: LocalCoordinatorGroup;
}): void {
  if (group.members.size !== 0) return;
  const byFileSystemId = localCoordinatorGroups.get(localCoordinationIdentity);
  if (byFileSystemId?.get(fileSystemId) !== group) return;
  byFileSystemId.delete(fileSystemId);
  if (byFileSystemId.size === 0) {
    localCoordinatorGroups.delete(localCoordinationIdentity);
  }
}

function serializeCoordinatorError({ error }: {
  error: unknown;
}): SerializedCoordinatorError {
  if (error instanceof HizoFSCorruptionError) {
    return {
      type: 'corruption',
      name: error.name,
      message: error.message,
    };
  }
  if (error instanceof HizoFSPublicationOutcomeUnknownError) {
    return {
      type: 'publication_outcome_unknown',
      name: error.name,
      message: error.message,
    };
  }
  if (error instanceof HizoFSUnsupportedFormatError) {
    return {
      type: 'unsupported_format',
      name: error.name,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      type: 'error',
      name: error.name,
      message: error.message,
    };
  }
  return {
    type: 'error',
    name: 'Error',
    message: 'Unknown HizoFS coordinator error',
  };
}

function deserializeCoordinatorError({ error }: {
  error: SerializedCoordinatorError;
}): Error {
  switch (error.type) {
  case 'corruption':
    return new HizoFSCorruptionError({
      message: error.message,
      cause: undefined,
    });
  case 'publication_outcome_unknown':
    return new HizoFSPublicationOutcomeUnknownError({ message: error.message });
  case 'unsupported_format':
    return new HizoFSUnsupportedFormatError({ message: error.message });
  case 'error': {
    const reconstructed = new Error(error.message);
    reconstructed.name = error.name;
    return reconstructed;
  }
  default: {
    const _ex: never = error.type;
    throw new Error(`Unhandled HizoFS coordinator error type: ${_ex}`);
  }
  }
}

function postCoordinatorMessage({
  channel,
  message,
}: {
  channel: BroadcastChannel;
  message: CoordinatorMessage;
}): void {
  channel.postMessage(message);
}

export class HizoFSActiveStateCoordinator {
  constructor({
    fileSystemId,
    localCoordinationIdentity,
    loadFromBacking,
    publishFromState,
    setHeadHandleRetention,
    diagnostics,
  }: {
    fileSystemId: string;
    localCoordinationIdentity: object;
    loadFromBacking: () => Promise<HizoFSActiveState>;
    publishFromState: ({
      currentState,
      publicationId,
      inodeIndexRootObjectId,
    }: {
      currentState: HizoFSActiveState;
      publicationId: string;
      inodeIndexRootObjectId: string;
    }) => Promise<HizoFSActiveState>;
    setHeadHandleRetention: ({
      retention,
    }: {
      retention: 'ephemeral' | 'persistent';
    }) => Promise<void>;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.fileSystemId = fileSystemId;
    this.localCoordinationIdentity = localCoordinationIdentity;
    this.instanceId = createHizoFSStableId();
    this.loadFromBacking = loadFromBacking;
    this.publishFromState = publishFromState;
    this.setHeadHandleRetention = setHeadHandleRetention;
    this.diagnostics = diagnostics;
  }

  private readonly fileSystemId: string;
  private readonly localCoordinationIdentity: object;
  private readonly instanceId: string;
  private readonly loadFromBacking: () => Promise<HizoFSActiveState>;
  private readonly publishFromState: ({
    currentState,
    publicationId,
    inodeIndexRootObjectId,
  }: {
    currentState: HizoFSActiveState;
    publicationId: string;
    inodeIndexRootObjectId: string;
  }) => Promise<HizoFSActiveState>;
  private readonly setHeadHandleRetention: ({
    retention,
  }: {
    retention: 'ephemeral' | 'persistent';
  }) => Promise<void>;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly rememberedResponses = new Map<string, RememberedResponse>();
  private readonly releaseLeadership = Promise.withResolvers<void>();
  private readonly leadershipAbortController = new AbortController();
  private channel: BroadcastChannel | undefined;
  private startPromise: Promise<void> | undefined;
  private electionPromise: Promise<void> | undefined;
  private operationChain: Promise<void> = Promise.resolve();
  private activeState: HizoFSActiveState | undefined;
  private leaderInitializationError: unknown | undefined;
  private isLeader = false;
  private hasPreviouslyObservedLeader = false;
  private closed = false;

  async loadActiveState(): Promise<HizoFSActiveState> {
    const result = await this.request({ operation: { type: 'load_active_state' } });
    switch (result.type) {
    case 'active_state':
      return freezeHizoFSActiveState({ state: result.state });
    case 'current_check':
    case 'publication':
      throw new Error(`Unexpected HizoFS coordinator result: ${result.type}`);
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS coordinator result: ${String(_ex)}`);
    }
    }
  }

  async isCurrent({ commitObjectId }: {
    commitObjectId: string;
  }): Promise<boolean> {
    const result = await this.request({
      operation: {
        type: 'is_current',
        commitObjectId,
      },
    });
    switch (result.type) {
    case 'current_check':
      return result.isCurrent;
    case 'active_state':
    case 'publication':
      throw new Error(`Unexpected HizoFS coordinator result: ${result.type}`);
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS coordinator result: ${String(_ex)}`);
    }
    }
  }

  async publish({
    publicationId,
    expectedCommitObjectId,
    expectedRevision,
    inodeIndexRootObjectId,
    flushPreparedRecords,
  }: {
    publicationId: string;
    expectedCommitObjectId: string;
    expectedRevision: number;
    inodeIndexRootObjectId: string;
    flushPreparedRecords: () => Promise<void>;
  }): Promise<HizoFSCoordinatorPublishResult> {
    await this.ensureStarted();
    const localLeader = getLocalCoordinatorGroup({
      localCoordinationIdentity: this.localCoordinationIdentity,
      fileSystemId: this.fileSystemId,
    }).leader;
    if (localLeader !== this) {
      // A leader in another runtime cannot flush frames buffered by this
      // runtime. Make them durable before sending only the resulting root
      // reference. The authoritative runtime skips this extra flush and lets
      // head publication flush the metadata tail once.
      await flushPreparedRecords();
    }
    const result = await this.request({
      operation: {
        type: 'publish',
        publicationId,
        expectedCommitObjectId,
        expectedRevision,
        inodeIndexRootObjectId,
      },
    });
    switch (result.type) {
    case 'publication':
      switch (result.publication.type) {
      case 'retry':
        return {
          type: 'retry',
          state: freezeHizoFSActiveState({ state: result.publication.state }),
        };
      case 'published':
        return {
          type: 'published',
          state: freezeHizoFSActiveState({ state: result.publication.state }),
        };
      default: {
        const _ex: never = result.publication;
        throw new Error(
          `Unhandled HizoFS coordinator publication: ${
            ((_ex satisfies never) as { readonly type: string }).type
          }`,
        );
      }
      }
    case 'active_state':
    case 'current_check':
      throw new Error(`Unexpected HizoFS coordinator result: ${result.type}`);
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS coordinator result: ${String(_ex)}`);
    }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const wasLeader = this.isLeader;
    this.closed = true;
    this.leadershipAbortController.abort();
    for (const pending of this.pendingRequests.values()) {
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer);
      pending.settled.reject(new Error('HizoFS coordinator closed'));
    }
    this.pendingRequests.clear();
    if (wasLeader) {
      // Do not release the coordinator Web Lock or its persistent head handles
      // while a serialized publication is still using them.
      await this.operationChain;
    }
    this.releaseLeadership.resolve();
    const group = localCoordinatorGroups.get(this.localCoordinationIdentity)?.get(this.fileSystemId);
    const wasLocalLeader = group?.leader === this;
    group?.members.delete(this);
    if (wasLocalLeader && group !== undefined) {
      group.leader = undefined;
    }
    this.channel?.close();
    this.channel = undefined;
    // A follower's Web Locks request may still be queued behind a long-lived
    // leader. Abort it, but do not wait for a test/polyfill implementation
    // that ignores LockOptions.signal; the callback checks `closed` before
    // acquiring any resources. A leader does wait so its retained head handles
    // are released before the runtime closes its backing store.
    if (wasLeader) {
      // `electionPromise` already suppresses only the expected queued-request
      // AbortError. Propagate failures from releasing persistent head handles
      // instead of hiding cleanup errors merely because close() set `closed`.
      await this.electionPromise;
    }
    if (this.isLeader) {
      await this.leaveLeadership();
    }
    if (
      wasLocalLeader
      && group !== undefined
      && (typeof navigator === 'undefined' || navigator.locks === undefined)
    ) {
      const next = group.members.values().next().value as
        | HizoFSActiveStateCoordinator
        | undefined;
      if (next !== undefined && !next.closed) {
        next.hasPreviouslyObservedLeader = true;
        await next.enterLeadership();
      }
    }
    if (group !== undefined) {
      deleteLocalCoordinatorGroupIfEmpty({
        localCoordinationIdentity: this.localCoordinationIdentity,
        fileSystemId: this.fileSystemId,
        group,
      });
    }
  }

  private async request({ operation }: {
    operation: HizoFSCoordinatorOperation;
  }): Promise<HizoFSCoordinatorOperationResult> {
    if (this.closed) {
      throw new Error('HizoFS coordinator is closed');
    }
    await this.ensureStarted();
    const localLeader = getLocalCoordinatorGroup({
      localCoordinationIdentity: this.localCoordinationIdentity,
      fileSystemId: this.fileSystemId,
    }).leader;
    if (localLeader !== undefined) {
      if (localLeader !== this) this.hasPreviouslyObservedLeader = true;
      this.diagnostics?.recordCoordinatorEvent({ event: 'local_request' });
      return await localLeader.runOperation({
        operation,
        delivery: { type: 'local' },
      });
    }
    if (this.channel === undefined) {
      throw new Error('HizoFS coordinator transport is unavailable');
    }

    const requestId = createHizoFSStableId();
    const settled = Promise.withResolvers<HizoFSCoordinatorOperationResult>();
    const pending: PendingRequest = {
      operation,
      settled,
      acknowledgedLeaderId: undefined,
      awaitingAcknowledgedResponse: false,
      retryTimer: undefined,
      timeoutTimer: undefined,
    };
    this.pendingRequests.set(requestId, pending);
    this.sendPendingRequest({ requestId, pending });
    switch (operation.type) {
    case 'load_active_state':
      pending.timeoutTimer = setTimeout(() => {
        if (!this.pendingRequests.delete(requestId)) return;
        if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
        settled.reject(new Error('Timed out waiting for the HizoFS coordinator'));
      }, COORDINATOR_REQUEST_TIMEOUT_MS);
      break;
    case 'is_current':
    case 'publish':
      break;
    default: {
      const _ex: never = operation;
      throw new Error(
        `Unhandled HizoFS coordinator operation: ${
          ((_ex satisfies never) as { readonly type: string }).type
        }`,
      );
    }
    }
    // Publication and its linearized current-state checks must not fail
    // locally while an acknowledged leader may still complete the durable
    // operation. Reuse the same publication ID across transport retries; a
    // successor recognizes the active result or fails closed when a later
    // generation makes the outcome indeterminate.
    return await settled.promise;
  }


  private sendPendingRequest({ requestId, pending }: {
    requestId: string;
    pending: PendingRequest;
  }): void {
    const channel = this.channel;
    if (
      this.closed
      || channel === undefined
      || this.pendingRequests.get(requestId) !== pending
      || pending.awaitingAcknowledgedResponse
    ) {
      return;
    }
    postCoordinatorMessage({
      channel,
      message: {
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        messageType: 'request',
        requestId,
        senderId: this.instanceId,
        previouslyAcknowledgedLeaderId: pending.acknowledgedLeaderId,
        operation: pending.operation,
      },
    });
    pending.retryTimer = setTimeout(() => {
      this.sendPendingRequest({ requestId, pending });
    }, COORDINATOR_RETRY_INTERVAL_MS);
  }

  private ensureStarted(): Promise<void> {
    this.startPromise ??= this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const group = getLocalCoordinatorGroup({
      localCoordinationIdentity: this.localCoordinationIdentity,
      fileSystemId: this.fileSystemId,
    });
    group.members.add(this);

    if (typeof navigator === 'undefined' || navigator.locks === undefined) {
      if (group.leader === undefined) {
        await this.enterLeadership();
      }
      return;
    }

    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('Cross-realm HizoFS coordination requires BroadcastChannel');
    }
    this.channel = new BroadcastChannel(`hizofs/${this.fileSystemId}/coordinator`);
    this.channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.receiveMessage({ value: event.data });
    });
    // TODO(hizofs): Add lifecycle-aware leadership handoff before a page or
    // Worker is frozen or placed into BFCache. Handoff must wait for the
    // serialized publication chain, close persistent head handles before the
    // Web Lock is released, and require the successor to reload both A/B heads
    // before serving requests. A SharedWorker owner may replace this lease when
    // standalone/file-protocol constraints can preserve the same guarantees.
    this.electionPromise = navigator.locks.request(
      `hizofs/${this.fileSystemId}/coordinator-owner`,
      {
        mode: 'exclusive',
        signal: this.leadershipAbortController.signal,
      },
      async () => {
        if (this.closed) return;
        await this.enterLeadership();
        await this.releaseLeadership.promise;
        await this.leaveLeadership();
      },
    ).then(() => undefined).catch(error => {
      if (this.closed && error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      throw error;
    });
  }

  private async enterLeadership(): Promise<void> {
    this.leaderInitializationError = undefined;
    const group = getLocalCoordinatorGroup({
      localCoordinationIdentity: this.localCoordinationIdentity,
      fileSystemId: this.fileSystemId,
    });
    this.diagnostics?.recordCoordinatorEvent({
      event: this.hasPreviouslyObservedLeader
        ? 'failover'
        : 'leadership_acquisition',
    });
    try {
      await this.setHeadHandleRetention({ retention: 'persistent' });
      this.activeState = freezeHizoFSActiveState({
        state: await this.loadFromBacking(),
      });
      this.diagnostics?.recordCoordinatorEvent({ event: 'durable_reload' });
    } catch (error) {
      this.activeState = undefined;
      this.leaderInitializationError = error;
    }
    this.isLeader = true;
    group.leader = this;
    this.servePendingRequestsAsLeader();
    if (this.channel !== undefined) {
      postCoordinatorMessage({
        channel: this.channel,
        message: {
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          messageType: 'leader_ready',
          leaderId: this.instanceId,
        },
      });
    }
  }


  private servePendingRequestsAsLeader(): void {
    for (const [requestId, pending] of [...this.pendingRequests]) {
      if (this.pendingRequests.get(requestId) !== pending) continue;
      this.pendingRequests.delete(requestId);
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer);
      void this.runOperation({
        operation: pending.operation,
        delivery: {
          type: 'remote',
          previouslyAcknowledgedLeaderId: pending.acknowledgedLeaderId,
        },
      }).then(
        pending.settled.resolve,
        pending.settled.reject,
      );
    }
  }

  private async leaveLeadership(): Promise<void> {
    if (!this.isLeader) return;
    this.isLeader = false;
    const group = localCoordinatorGroups.get(this.localCoordinationIdentity)?.get(this.fileSystemId);
    if (group?.leader === this) group.leader = undefined;
    this.activeState = undefined;
    this.leaderInitializationError = undefined;
    await this.setHeadHandleRetention({ retention: 'ephemeral' });
  }

  private receiveMessage({ value }: { value: unknown }): void {
    if (this.closed) return;
    const parsed = CoordinatorMessageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.messageType) {
    case 'leader_ready':
      if (message.leaderId !== this.instanceId) {
        this.hasPreviouslyObservedLeader = true;
        for (const [requestId, pending] of this.pendingRequests) {
          pending.awaitingAcknowledgedResponse = false;
          if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
          this.sendPendingRequest({ requestId, pending });
        }
      }
      return;
    case 'request_acknowledged': {
      if (message.recipientId !== this.instanceId) return;
      this.hasPreviouslyObservedLeader = true;
      const pending = this.pendingRequests.get(message.requestId);
      if (pending === undefined) return;
      pending.acknowledgedLeaderId = message.leaderId;
      pending.awaitingAcknowledgedResponse = true;
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
      pending.retryTimer = setTimeout(() => {
        pending.awaitingAcknowledgedResponse = false;
        this.sendPendingRequest({
          requestId: message.requestId,
          pending,
        });
      }, COORDINATOR_RESPONSE_RETRY_INTERVAL_MS);
      return;
    }
    case 'response': {
      if (message.recipientId !== this.instanceId) return;
      this.hasPreviouslyObservedLeader = true;
      const pending = this.pendingRequests.get(message.requestId);
      if (pending === undefined) return;
      this.pendingRequests.delete(message.requestId);
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer);
      switch (message.response.type) {
      case 'success':
        pending.settled.resolve(message.response.result);
        return;
      case 'failure':
        pending.settled.reject(
          deserializeCoordinatorError({ error: message.response.error }),
        );
        return;
      default: {
        const _ex: never = message.response;
        throw new Error(`Unhandled HizoFS coordinator response: ${String(_ex)}`);
      }
      }
    }
    case 'request':
      if (!this.isLeader || message.senderId === this.instanceId) return;
      if (this.channel !== undefined) {
        postCoordinatorMessage({
          channel: this.channel,
          message: {
            protocolVersion: COORDINATOR_PROTOCOL_VERSION,
            messageType: 'request_acknowledged',
            requestId: message.requestId,
            recipientId: message.senderId,
            leaderId: this.instanceId,
          },
        });
      }
      this.diagnostics?.recordCoordinatorEvent({ event: 'remote_request' });
      void this.respondToRequest({ message });
      return;
    default: {
      const _ex: never = message;
      throw new Error(`Unhandled HizoFS coordinator message: ${String(_ex)}`);
    }
    }
  }

  private async respondToRequest({ message }: {
    message: CoordinatorRequestMessage;
  }): Promise<void> {
    const channel = this.channel;
    if (channel === undefined) return;
    const responseKey = `${message.senderId}/${message.requestId}`;
    let remembered = this.rememberedResponses.get(responseKey);
    if (remembered === undefined) {
      remembered = this.rememberResponse({
        responseKey,
        responsePromise: this.createResponse({ message }),
      });
    }
    const response = await remembered.promise;
    if (this.closed || this.channel !== channel) return;
    postCoordinatorMessage({
      channel,
      message: {
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        messageType: 'response',
        requestId: message.requestId,
        recipientId: message.senderId,
        response,
      },
    });
  }

  private async createResponse({ message }: {
    message: CoordinatorRequestMessage;
  }): Promise<CoordinatorResponseMessage['response']> {
    try {
      return {
        type: 'success',
        result: await this.runOperation({
          operation: message.operation,
          delivery: {
            type: 'remote',
            previouslyAcknowledgedLeaderId:
              message.previouslyAcknowledgedLeaderId,
          },
        }),
      };
    } catch (error) {
      return {
        type: 'failure',
        error: serializeCoordinatorError({ error }),
      };
    }
  }

  private runOperation({ operation, delivery }: {
    operation: HizoFSCoordinatorOperation;
    delivery: CoordinatorOperationDelivery;
  }): Promise<HizoFSCoordinatorOperationResult> {
    switch (operation.type) {
    case 'load_active_state':
      // The active-state tuple is immutable and replaced only after a durable
      // publication completes. Concurrent readers may safely observe the old
      // complete generation without waiting behind the publication queue.
      return this.executeOperation({ operation, delivery });
    case 'is_current':
    case 'publish':
      // Mutation validation must be linearized with publication. Returning a
      // stale `true` while an earlier publication is still durable-pending can
      // make a failed or no-op mutation incorrectly commit its old-state
      // decision. Queue both checks and publications on the same chain.
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled HizoFS coordinator operation: ${String(_ex)}`);
    }
    }

    const result = Promise.withResolvers<HizoFSCoordinatorOperationResult>();
    this.operationChain = this.operationChain
      .then(async () => {
        try {
          result.resolve(await this.executeOperation({ operation, delivery }));
        } catch (error) {
          result.reject(error);
        }
      })
      .catch(() => {
        // The per-operation promise carries the failure; keep the serialization
        // chain usable for later requests.
      });
    return result.promise;
  }

  private async executeOperation({ operation, delivery }: {
    operation: HizoFSCoordinatorOperation;
    delivery: CoordinatorOperationDelivery;
  }): Promise<HizoFSCoordinatorOperationResult> {
    if (!this.isLeader) {
      throw new Error('HizoFS coordinator leadership changed during an operation');
    }
    if (this.leaderInitializationError !== undefined) {
      throw this.leaderInitializationError;
    }
    const currentState = this.activeState;
    if (currentState === undefined) {
      throw new Error('HizoFS coordinator has no active state');
    }
    switch (operation.type) {
    case 'load_active_state':
      this.diagnostics?.recordCoordinatorEvent({ event: 'active_state_cache_hit' });
      return {
        type: 'active_state',
        state: currentState,
      };
    case 'is_current':
      return {
        type: 'current_check',
        isCurrent: currentState.commitObjectId === operation.commitObjectId,
      };
    case 'publish': {
      if (currentState.commitObjectId !== operation.expectedCommitObjectId) {
        if (currentState.commit.publicationId === operation.publicationId) {
          if (
            currentState.commit.revision !== operation.expectedRevision + 1
            || currentState.commit.inodeIndexRootObjectId
              !== operation.inodeIndexRootObjectId
          ) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS publication ID is bound to inconsistent commit data',
              cause: undefined,
            });
          }
          return {
            type: 'publication',
            publication: {
              type: 'published',
              state: currentState,
            },
          };
        }
        switch (delivery.type) {
        case 'local':
          break;
        case 'remote':
          if (delivery.previouslyAcknowledgedLeaderId !== undefined) {
            throw new HizoFSPublicationOutcomeUnknownError({
              message:
                'A previous HizoFS coordinator acknowledged this publication '
                + 'but its durable outcome is no longer the active generation',
            });
          }
          break;
        default: {
          const _ex: never = delivery;
          throw new Error(`Unhandled coordinator delivery: ${String(_ex)}`);
        }
        }
        return {
          type: 'publication',
          publication: {
            type: 'retry',
            state: currentState,
          },
        };
      }
      if (currentState.commit.revision !== operation.expectedRevision) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS commit revision is inconsistent with its object ID',
          cause: undefined,
        });
      }
      const state = freezeHizoFSActiveState({
        state: await this.publishFromState({
          currentState,
          publicationId: operation.publicationId,
          inodeIndexRootObjectId: operation.inodeIndexRootObjectId,
        }),
      });
      this.activeState = state;
      return {
        type: 'publication',
        publication: {
          type: 'published',
          state,
        },
      };
    }
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled HizoFS coordinator operation: ${String(_ex)}`);
    }
    }
  }

  private rememberResponse({ responseKey, responsePromise }: {
    responseKey: string;
    responsePromise: Promise<CoordinatorResponseMessage['response']>;
  }): RememberedResponse {
    const remembered: RememberedResponse = {
      promise: responsePromise,
      state: 'pending',
    };
    this.rememberedResponses.set(responseKey, remembered);
    void responsePromise.then(() => {
      remembered.state = 'settled';
      this.pruneRememberedResponses();
    });
    this.pruneRememberedResponses();
    return remembered;
  }

  private pruneRememberedResponses(): void {
    if (this.rememberedResponses.size <= MAXIMUM_REMEMBERED_RESPONSES) return;
    for (const [responseKey, remembered] of this.rememberedResponses) {
      if (this.rememberedResponses.size <= MAXIMUM_REMEMBERED_RESPONSES) return;
      switch (remembered.state) {
      case 'pending':
        break;
      case 'settled':
        this.rememberedResponses.delete(responseKey);
        break;
      default: {
        const _ex: never = remembered.state;
        throw new Error(`Unhandled remembered response state: ${_ex}`);
      }
      }
    }
  }
}

export type { HizoFSCoordinatorPublishResult };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  CoordinatorMessageSchema,
  localCoordinatorGroups,
};
