import { z } from 'zod';
import { encodeProtocolHeader, inspectProtocolHeader, PROTOCOL_HEADER_BYTES } from './protocol-header';
import { ascii, joinBytes, ownBytes, requireValue } from './bytes';

const routeSchema = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const frameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hello'), body: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength === 128) }),
  z.strictObject({ kind: z.literal('routed'), channel: routeSchema, route: routeSchema, body: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength <= 65280) }),
]);
export type PeerEnvelope = z.infer<typeof frameSchema>;
export function encodePeerEnvelope({ envelope }: { envelope: PeerEnvelope }): Uint8Array {
  const parsed = frameSchema.parse(envelope);
  let body: Uint8Array;
  switch (parsed.kind) {
  case 'hello': body = joinBytes({ parts: [new Uint8Array([16]), parsed.body] }); break;
  case 'routed': {
    const channel = ascii({ text: parsed.channel }), route = ascii({ text: parsed.route });
    body = joinBytes({ parts: [new Uint8Array([17, channel.length, route.length]), channel, route, parsed.body] }); break;
  }
  default: { const exhaustive: never = parsed; throw new Error(String(exhaustive)); }
  }
  const bytes = joinBytes({ parts: [encodeProtocolHeader(), body] });
  requireValue({ condition: bytes.byteLength <= 65536, message: 'Peer envelope capacity' }); return bytes;
}
export function decodePeerEnvelope({ bytes }: { bytes: Uint8Array }): PeerEnvelope | undefined {
  const header = inspectProtocolHeader({ bytes, maxBytes: 65536 });
  switch (header.kind) {
  case 'supported': break;
  case 'truncated-header': case 'wrong-protocol-magic': case 'invalid-protocol-version': case 'unsupported-protocol-version': case 'oversized-message': return undefined;
  default: { const exhaustive: never = header; throw new Error(String(exhaustive)); }
  }
  const input = ownBytes({ bytes, maxBytes: 65536 }), kind = input[PROTOCOL_HEADER_BYTES];
  if (kind === 16) {
    const result = frameSchema.safeParse({ kind: 'hello', body: input.slice(PROTOCOL_HEADER_BYTES + 1) }); return result.success ? result.data : undefined;
  }
  if (kind !== 17 || input.length < PROTOCOL_HEADER_BYTES + 3) return undefined;
  const channelLength = input[14]!, routeLength = input[15]!, start = 16;
  if (start + channelLength + routeLength > input.length) return undefined;
  const channel = String.fromCharCode(...input.subarray(start, start + channelLength));
  const route = String.fromCharCode(...input.subarray(start + channelLength, start + channelLength + routeLength));
  const result = frameSchema.safeParse({ kind: 'routed', channel, route, body: input.slice(start + channelLength + routeLength) });
  return result.success ? result.data : undefined;
}
export const TEST_ONLY = {
};
