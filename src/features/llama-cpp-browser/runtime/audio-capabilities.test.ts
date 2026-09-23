import { describe, expect, it } from 'vitest';
import { AUDIO_LANGUAGE_AUTO_QUERY, audioRuntimeCapabilities } from './audio-capabilities';
const query = { name: AUDIO_LANGUAGE_AUTO_QUERY, returnKind: 'boolean', parameters: [{ kind: 'pointer' }] };
describe('audio capability negotiation', () => {
  it('enables auto only when the bound function has the expected contract', () => {
    expect(audioRuntimeCapabilities({ schema: { functions: [query] } }).languageAuto).toBe(true);
  });
  it.each([undefined, {}, { functions: [] }, { functions: [{ ...query, returnKind: 'record' }] },
    { functions: [{ ...query, parameters: [] }] }, { functions: [{ ...query, parameters: [{ kind: 'signed' }] }] }
  ])('does not claim automatic language on old or malformed schemas: %j', schema => {
    expect(audioRuntimeCapabilities({ schema }).languageAuto).toBe(false);
  });
});
