import { z } from 'zod';

export const visionProtocol = 'targeted-vision-en-v1' as const;
export const visionPrompt = 'Describe the visible geometric shapes and colors briefly in English.';
export const visionFixture = {
  id: 'rgb-quadrants-512-v1',
  generator: 'integer-quadrants-white-center-v1',
  mime: 'image/png',
  width: 512,
  height: 512,
  bytes: 2346,
  sha256: 'ef9d782d4850b63fadc18fd5e28d7c827185b45f4811d2df9d08234fb9069a9a',
  expectedRgbSha256: '37b564bc83ebf6c67cfdea04676f7a2a146aa1e3efbeb1ca33e3c3693628b422',
} as const;
export const visionFixtureSchema = z.object({
  id: z.literal(visionFixture.id),
  generator: z.literal(visionFixture.generator),
  mime: z.literal(visionFixture.mime),
  width: z.literal(512),
  height: z.literal(512),
  bytes: z.literal(visionFixture.bytes),
  sha256: z.literal(visionFixture.sha256),
  // Expected source pixels, not proof of the browser's decoded RGB bytes.
  expectedRgbSha256: z.literal(visionFixture.expectedRgbSha256),
}).strict();
export const visionTrialSchema = z.object({ fixtureId: z.literal(visionFixture.id), residency: z.enum(['cold', 'warm']) }).strict();

export const TEST_ONLY = {
};
