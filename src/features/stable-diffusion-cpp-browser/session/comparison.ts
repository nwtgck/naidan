import type { ImageGenerationAsset, ImageGenerationRun } from '@/01-models/image-generation';
export type ImageGenerationComparisonImage = { asset: ImageGenerationAsset, run: ImageGenerationRun };

/** Compare saved facts, never live form values. Model locator equality is not a
 * claim of bitwise reproducibility on different devices or changed file bytes. */
export function compareImageGenerationImages({ left, right }: { left: ImageGenerationComparisonImage, right: ImageGenerationComparisonImage }) {
  function fields({ image }: { image: ImageGenerationComparisonImage }): Record<string, unknown> {
    return { ...image.run.request.parameters, seed: image.asset.seed,
      models: image.run.request.models, loras: image.run.request.loras, inputs: image.run.request.imageInputs,
      runtime: image.run.request.runtime, modelVersion: image.asset.result.modelVersion,
      outputWidth: image.asset.result.width, outputHeight: image.asset.result.height };
  }
  const a = fields({ image: left }), b = fields({ image: right });
  return Object.keys(a).map(key => ({ key, left: JSON.stringify(a[key]) ?? '', right: JSON.stringify(b[key]) ?? '', same: JSON.stringify(a[key]) === JSON.stringify(b[key]) }));
}
export const TEST_ONLY = {
};
