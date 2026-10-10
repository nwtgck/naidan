// Service-level tests may integrate persistence schemas, mappers and storage fixtures.
// Snapshot construction is exercised separately in the image feature.
import { expect, it } from 'vitest';
import { reactive } from 'vue';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey, toImageGenerationId, toImageGenerationSessionId, toBinaryObjectId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { imageGenerationRequestToDomain, imageGenerationRequestToDto, imageGenerationToDomain, imageGenerationToDto } from '@/00-storage/mapper/image-generation-history';
import { ExperimentalImageGenerationSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { ExperimentalImageGenerationRunSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';

function remote() {
  const run = generationRunFixture({ id: 'run-example', sessionId: toImageGenerationSessionId({ raw: 'session-example' }), count: 1, seed: '42' });
  run.request.runtime = {
    profile: 'naidan-rpc',
    registrationId: toNaidanRpcRegistrationId({ raw: 'connection-example' }),
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'A'.repeat(43) }),
    label: 'Remote machine',
    modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/remote/example.gguf' }, expected: { size: 1000, lastModified: 1 } } }, components: [], loras: [] },
  };
  run.request.models = []; run.request.loras = [];
  for (const key of ['vaeTiling', 'vaeTileSize', 'flashAttention', 'bf16WeightType', 'qwenVaePolicy', 'conditioningCacheSize', 'modelArguments'] as const) delete run.request.parameters[key];
  return run;
}

it('roundtrips remote provenance without claiming local files or native settings', () => {
  const run = remote(); const dto = imageGenerationRequestToDto({ request: reactive(run.request) });
  expect(() => structuredClone(dto)).not.toThrow();
  expect(imageGenerationRequestToDomain({ request: dto })).toEqual(run.request);
  expect(dto.models).toEqual([]); expect(dto.parameters).not.toHaveProperty('modelArguments');
  expect(ExperimentalImageGenerationRunSchemaDto.parse({ ...run, request: dto }).request).toEqual(dto);
});

it('preserves unknown recovery facts while retaining a valid image asset', () => {
  const run = remote();
  const record: ImageGenerationRecord = {
    id: toImageGenerationId({ raw: 'output-example' }),
    createdAt: 1,
    request: run.request,
    result: {
      binaryObjectId: toBinaryObjectId({ raw: 'output-binary' }),
      width: 256,
      height: 256,
      elapsedMs: 2,
      confirmation: 'unconfirmed',
      modelVersion: undefined,
      uniformOutput: undefined,
    },
    previews: [],
  };
  const dto = ExperimentalImageGenerationSchemaDto.parse(imageGenerationToDto({ record }));
  expect(imageGenerationToDomain({ dto })).toEqual(record);
  const extended = ExperimentalImageGenerationSchemaDto.parse({ ...dto, result: { ...dto.result, future: true } });
  expect(imageGenerationToDomain({ dto: extended })).toEqual(record);
  expect(dto.result).toMatchObject({ confirmation: 'unconfirmed', modelVersion: undefined });
  expect(ExperimentalImageGenerationSchemaDto.safeParse({ ...dto, result: { ...dto.result, confirmation: 'confirmed' } }).success).toBe(false);
});

it('rejects unknown profiles but retains remote provenance with an unfamiliar peer ID', () => {
  const run = remote();
  expect(() => imageGenerationRequestToDto({ request: { ...run.request, runtime: { ...run.request.runtime, profile: 'unknown-provider' } as never } })).toThrow();
  expect(() => imageGenerationRequestToDto({ request: { ...run.request, runtime: { ...run.request.runtime, peerPublicKey: 'wrong' } as never } })).toThrow();
});

it('keeps old local history requests readable without adding a remote tag', () => {
  const run = generationRunFixture({ id: 'run-example', sessionId: toImageGenerationSessionId({ raw: 'session-example' }), count: 1, seed: '42' });
  expect(imageGenerationRequestToDomain({ request: imageGenerationRequestToDto({ request: run.request }) })).toEqual(run.request);
});

export const TEST_ONLY = {
};
