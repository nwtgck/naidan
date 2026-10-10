import { SCALAR, UNKNOWN } from '../../analysis/values.ts';
import { isScalarValue, passiveData } from '../../analysis/value-guards.ts';
import type { OperationRule } from '../operation.ts';
import { passiveArguments, scalarArguments } from './guards.ts';

export const NETWORK_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'fetch.request',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['fetch', 'window.fetch', 'globalThis.fetch'],
    policy: { kind: 'tracked', effects: ['network.http'], reason: 'A fetch may request network data even if a browser cache satisfies a particular call.' },
    evaluate: input => {
      const { context, args, node } = input;
      if (args[0] === undefined || !isScalarValue(args[0]) || args.slice(1).some(value => !passiveData({ value, seen: new Set() }))) {
        context.issue({ node, code: 'unsupported', message: 'Fetch input coercion needs scalar URLs and checked passive option data.' });
      }
      return { kind: 'promise', value: context.native({ name: 'Response', receiver: undefined }) };
    },
  },
  {
    id: 'beacon.send',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['navigator.sendBeacon'],
    policy: { kind: 'tracked', effects: ['network.http'], reason: 'Queueing a beacon requests network transmission.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
  {
    id: 'worker.script-acquisition',
    definedIn: import.meta.url,
    access: 'construct',
    targets: ['Worker'],
    policy: { kind: 'tracked', effects: ['network.http'], reason: 'Worker script acquisition after entry validation; backend initialization is a separate dependency edge.' },
    // The worker adapter validates the literal entry before selecting this rule.
    // It also evaluates other argument expressions; this rule does not re-run them.
    evaluate: () => SCALAR,
  },
  ...([
    { name: 'WebSocket', effect: 'network.websocket', methods: ['send', 'close'] },
    { name: 'RTCPeerConnection', effect: 'network.webrtc', methods: ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate', 'addTrack', 'removeTrack', 'addTransceiver', 'getStats', 'close', 'restartIce', 'setConfiguration'] },
    { name: 'WebTransport', effect: 'network.webtransport', methods: ['createBidirectionalStream', 'createUnidirectionalStream', 'getStats', 'close'] },
    { name: 'EventSource', effect: 'network.http', methods: ['close'] },
  ] as const).flatMap(({ name, effect, methods }) => [
    {
      id: `${name}.connect`,
      definedIn: import.meta.url,
      access: 'construct',
      targets: [name],
      policy: { kind: 'tracked', effects: [effect], reason: 'Connection setup may initiate network activity before a send call.' },
      evaluate: input => {
        passiveArguments(input); return input.context.native({ name, receiver: undefined });
      },
    },
    {
      id: `${name}.control`,
      definedIn: import.meta.url,
      access: 'call',
      targets: methods.map(method => `${name}.${method}`),
      policy: { kind: 'tracked', effects: [effect], reason: 'Known transport operations retain a conservative network/control upper bound; unlisted methods have no implicit model.' },
      evaluate: input => {
        passiveArguments(input); return UNKNOWN;
      },
    },
  ] satisfies readonly OperationRule[]),
  {
    id: 'webrtc.create-data-channel',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['RTCPeerConnection.createDataChannel'],
    policy: { kind: 'tracked', effects: ['network.webrtc'], reason: 'A data channel belongs to the peer connection; preserve that provenance for later send/close calls.' },
    evaluate: input => {
      passiveArguments(input); return input.context.native({ name: 'RTCDataChannel', receiver: undefined });
    },
  },
  {
    id: 'webrtc.data-channel',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['RTCDataChannel.send', 'RTCDataChannel.close'],
    policy: { kind: 'tracked', effects: ['network.webrtc'], reason: 'Sending or closing a peer data channel is network I/O/control.' },
    evaluate: input => {
      passiveArguments(input); return SCALAR;
    },
  },
  {
    id: 'response.text',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['Response.text'],
    policy: { kind: 'intentional-none', reason: 'Body consumption belongs to the initiating request; do not charge a second HTTP request for decoding text.' },
    evaluate: () => ({ kind: 'promise', value: SCALAR }),
  },
  {
    id: 'response.decode',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['Response.arrayBuffer', 'Response.json'],
    policy: { kind: 'intentional-none', reason: 'Response decoding is not another request. The decoded value still lacks a checked shape in this model.' },
    evaluate: () => ({ kind: 'promise', value: UNKNOWN }),
  },
  {
    id: 'response.blob',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['Response.blob'],
    policy: { kind: 'intentional-none', reason: 'Retain the Blob result without erasing the original request effect or executing its bytes.' },
    evaluate: input => ({ kind: 'promise', value: input.context.native({ name: 'Blob', receiver: undefined }) }),
  },
  {
    id: 'response.metadata',
    definedIn: import.meta.url,
    access: 'read',
    targets: ['ok', 'status', 'statusText', 'url', 'redirected', 'type', 'bodyUsed'].map(key => `Response.${key}`),
    policy: { kind: 'intentional-none', reason: 'Already available response metadata does not initiate network traffic.' },
    evaluate: () => SCALAR,
  },
];
