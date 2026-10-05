import type { ImageGenerationRuntime, RemoteImageModelFile, RemoteImageModelSelection } from './image-generation-history';

export function copyRemoteImageSelection({ selection }: { selection: RemoteImageModelSelection }): RemoteImageModelSelection {
  const copyFile = ({ file }: { file: RemoteImageModelFile }): RemoteImageModelFile => {
    const { location, expected, ...rest } = file;
    rest satisfies Record<PropertyKey, never>;
    return { location: { ...location }, expected: expected && { ...expected } };
  };
  const { primary, components, loras, ...rest } = selection;
  rest satisfies Record<PropertyKey, never>;
  return { primary: { slot: primary.slot, file: copyFile({ file: primary.file }) },
    components: components.map(({ slot, file }) => ({ slot, file: copyFile({ file }) })),
    loras: loras.map(({ file, strength }) => ({ file: copyFile({ file }), strength })) };
}
export function isRemoteImageRuntime({ runtime }: { runtime: ImageGenerationRuntime }): boolean {
  switch (runtime.profile) {
  case 'naidan-rpc': return true;
  case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': return false;
  default: { const exhaustive: never = runtime; throw new Error(String(exhaustive)); }
  }
}
export function copyImageGenerationRuntime({ runtime }: { runtime: ImageGenerationRuntime }): ImageGenerationRuntime {
  switch (runtime.profile) {
  case 'naidan-rpc': return { ...runtime, modelSelection: runtime.modelSelection && copyRemoteImageSelection({ selection: runtime.modelSelection }) };
  case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': return { ...runtime };
  default: { const exhaustive: never = runtime; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
