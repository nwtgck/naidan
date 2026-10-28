// @vitest-environment node
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVisionFixture } from './vision-fixture';
import { visionFixture, visionPrompt, visionProtocol } from './vision-plan';
import { createVisionPerformancePlan } from './plan';
import { planSchema } from './types';
import { performancePlan } from '@/features/llama-cpp-browser/test-utils/performance.test-support';

describe('fixed authored image workload', () => {
  it('loads the committed PNG bytes and checks its complete independent RGB content', async () => {
    const blob = await createVisionFixture();
    const png = Buffer.from(await blob.arrayBuffer());
    expect(blob.type).toBe('image/png');
    expect(png.length).toBe(visionFixture.bytes);
    expect(createHash('sha256').update(png).digest('hex')).toBe(visionFixture.sha256);
    const idat: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const bytes = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
      if (type === 'IHDR') {
        expect([...png.subarray(offset + 8, offset + 21)]).toEqual([0, 0, 2, 0, 0, 0, 2, 0, 8, 2, 0, 0, 0]);
      }
      if (type === 'IDAT') {
        idat.push(png.subarray(offset + 8, offset + 8 + bytes));
      }
      offset += bytes + 12;
    }
    const pixels = inflateSync(Buffer.concat(idat)), rgb = Buffer.alloc(512 * 512 * 3);
    for (let y = 0; y < 512; y++) {
      expect(pixels[y * 1537]).toBe(0);
      rgb.set(pixels.subarray(y * 1537 + 1, (y + 1) * 1537), y * 1536);
    }
    expect(createHash('sha256').update(rgb).digest('hex')).toBe(visionFixture.expectedRgbSha256);
    expect([...rgb.subarray((256 * 512 + 256) * 3, (256 * 512 + 256) * 3 + 3)]).toEqual([255, 255, 255]);
  });

  it.each(['standard', 'both', 'gpu-profile'] as const)('separates initial and resident runs without continuation or extra diagnostics: %s', mode => {
    const source = performancePlan({ models: 2, repeats: 3, diagnostics: 'placement', mode });
    const plan = createVisionPerformancePlan(source);
    expect(plan.protocol).toBe(visionProtocol);
    expect(plan.visionFixture).toEqual(visionFixture);
    expect(plan.steps).toHaveLength(2 * 4 * (mode === 'both' ? 2 : 1));
    expect(plan.settings.diagnostics).toBe('none');
    for (const step of plan.steps) {
      expect(step.sequence).toBe('fresh');
      expect(step.dependsOn).toBeUndefined();
      expect(step.prompt).toBe(visionPrompt);
      expect(step.maxTokens).toBe(32);
      expect(step.vision?.residency).toBe(step.repetition === 0 ? 'cold' : 'warm');
    }
    expect(planSchema.safeParse({ ...source, visionFixture }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, visionFixture: undefined }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, steps: [{ ...plan.steps[0], sequence: 'continue' }] }).success).toBe(false);
  });
});
