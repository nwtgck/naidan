/** Static acquisition recipes, not a remote model catalog or an inference
 * compatibility database. Opening/expanding the catalog performs no I/O.
 * Repository revisions were checked on 2026-09-27. Quantized weights are
 * publisher-provided files; Naidan never asks the user to convert or re-split.
 * Keep paths relative to EACH repository, including split_files/ and vae/.
 */
export type ImageRecipeFile = {
  role: 'model' | 'diffusion' | 'vae' | 'lm';
  repository: string;
  revision: string;
  path: string;
  directory: string;
  approximateBytes: number;
};
export type ImageModelRecipe = {
  id: 'z-image-turbo' | 'qwen-image-2.1' | 'z-image-base' | 'sdxl-base-1.0' | 'flux2-klein-4b' | 'anima-turbo-1.1' | 'krea2-turbo' | 'ernie-image-turbo';
  title: string;
  recommendation?: 'maintainer-tested';
  files: readonly ImageRecipeFile[];
  components: readonly ImageRecipeComponent[];
  source: string;
};

const reviewedRecipes: readonly Omit<ImageModelRecipe, 'components'>[] = [
  // Recommended marks model families the maintainer has run and found to give
  // good results; it is curated UI copy, not a benchmark or auto-selection.
  {
    id: 'z-image-turbo', title: 'Z-Image-Turbo',
    recommendation: 'maintainer-tested',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/z_image.md',
    files: [
      { role: 'diffusion', repository: 'leejet/Z-Image-Turbo-GGUF', revision: 'a90f482a21813cdaf21422c4031628658680b5fd', path: 'z_image_turbo-Q4_K.gguf', directory: 'Z-Image-Turbo-GGUF', approximateBytes: 3860000000 },
      // Use the Z-Image distribution's VAE, avoiding an unrelated gated download.
      { role: 'vae', repository: 'Comfy-Org/z_image_turbo', revision: '93fae7d7f6189cc408fdd7cec36c91447b8506a2', path: 'split_files/vae/ae.safetensors', directory: 'z_image_turbo', approximateBytes: 335000000 },
      { role: 'lm', repository: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: '18727206c51467496bfba014368bd0a30e97f411', path: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', directory: 'Qwen3-4B-Instruct-2507-GGUF', approximateBytes: 2500000000 },
    ],
  },
  {
    id: 'qwen-image-2.1', title: 'Qwen Image 2.1',
    recommendation: 'maintainer-tested',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/qwen_image_2.1.md',
    files: [
      { role: 'diffusion', repository: 'leejet/Qwen-Image-2.1-GGUF', revision: '9db551d8368b5d1aa0b93cfe46cd54bb4750eae1', path: 'qwen_image_2.1-Q4_K.gguf', directory: 'Qwen-Image-2.1-GGUF', approximateBytes: 4200000000 },
      { role: 'vae', repository: 'Comfy-Org/Qwen-Image-2.1', revision: '8150226f50722886a275fa08e7b1fdf961732502', path: 'vae/qwen_image_2.1_vae_bf16.safetensors', directory: 'Qwen-Image-2.1', approximateBytes: 676000000 },
      { role: 'lm', repository: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', revision: '00e7d63528e65d7b64e80e1293a8360b4af6a594', path: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', directory: 'Qwen3-VL-8B-Instruct-GGUF', approximateBytes: 5030000000 },
    ],
  },
  {
    id: 'z-image-base', title: 'Z-Image Base',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/z_image.md',
    files: [
      { role: 'diffusion', repository: 'unsloth/Z-Image-GGUF', revision: 'c9913e69743c5d9dfa7fdac58a0cc5709a17aa08', path: 'z-image-Q4_K_M.gguf', directory: 'Z-Image-GGUF', approximateBytes: 5066995776 },
      { role: 'vae', repository: 'Comfy-Org/z_image_turbo', revision: '93fae7d7f6189cc408fdd7cec36c91447b8506a2', path: 'split_files/vae/ae.safetensors', directory: 'z_image_turbo', approximateBytes: 335000000 },
      { role: 'lm', repository: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: '18727206c51467496bfba014368bd0a30e97f411', path: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', directory: 'Qwen3-4B-Instruct-2507-GGUF', approximateBytes: 2500000000 },
    ],
  },
  {
    id: 'sdxl-base-1.0', title: 'SDXL Base 1.0',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/sd.md',
    files: [
      { role: 'model', repository: 'stabilityai/stable-diffusion-xl-base-1.0', revision: 'e4e60c65aa20ee60092c60ba197f541872cf9373', path: 'sd_xl_base_1.0.safetensors', directory: 'stable-diffusion-xl-base-1.0', approximateBytes: 6938078334 },
      // Match the upstream SDXL example's explicit VAE override. The checkpoint
      // also has a VAE; users can clear this selection to use that component.
      { role: 'vae', repository: 'madebyollin/sdxl-vae-fp16-fix', revision: 'c2fda8dd4afc6ddcb52e874cdc7ae79087cb8616', path: 'sdxl_vae.safetensors', directory: 'sdxl-vae-fp16-fix', approximateBytes: 334641162 },
    ],
  },
  {
    id: 'flux2-klein-4b', title: 'FLUX.2 [klein] 4B Distilled',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/flux2.md',
    files: [
      { role: 'diffusion', repository: 'leejet/FLUX.2-klein-4B-GGUF', revision: '4a253eddf43d4a449233a1cbd5fe8e8232110964', path: 'flux-2-klein-4b-Q4_0.gguf', directory: 'FLUX.2-klein-4B-GGUF', approximateBytes: 2460378560 },
      { role: 'vae', repository: 'Comfy-Org/vae-text-encorder-for-flux-klein-4b', revision: '5f526678002e43af5551dadb73ce2e8c91b43afe', path: 'split_files/vae/flux2-vae.safetensors', directory: 'vae-text-encorder-for-flux-klein-4b', approximateBytes: 336000000 },
      { role: 'lm', repository: 'Comfy-Org/vae-text-encorder-for-flux-klein-4b', revision: '5f526678002e43af5551dadb73ce2e8c91b43afe', path: 'split_files/text_encoders/qwen_3_4b.safetensors', directory: 'vae-text-encorder-for-flux-klein-4b', approximateBytes: 8040000000 },
    ],
  },
  {
    id: 'anima-turbo-1.1', title: 'Anima Turbo 1.1',
    source: 'https://huggingface.co/circlestone-labs/Anima',
    files: [
      { role: 'diffusion', repository: 'circlestone-labs/Anima', revision: 'f973fc41ec7545364ac9776c2440285f43ff2a30', path: 'split_files/diffusion_models/anima-turbo-v1.1.safetensors', directory: 'Anima', approximateBytes: 4182000000 },
      { role: 'vae', repository: 'circlestone-labs/Anima', revision: 'f973fc41ec7545364ac9776c2440285f43ff2a30', path: 'split_files/vae/qwen_image_vae.safetensors', directory: 'Anima', approximateBytes: 253800000 },
      { role: 'lm', repository: 'circlestone-labs/Anima', revision: 'f973fc41ec7545364ac9776c2440285f43ff2a30', path: 'split_files/text_encoders/qwen_3_06b_base.safetensors', directory: 'Anima', approximateBytes: 1192000000 },
    ],
  },
  {
    id: 'krea2-turbo', title: 'Krea 2 Turbo',
    recommendation: 'maintainer-tested',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/krea2.md',
    files: [
      { role: 'diffusion', repository: 'realrebelai/KREA-2_GGUFs', revision: '400cf1ca6790b96621e448b40c50650c76078e9e', path: 'TURBO/Krea-2-Turbo-Q4_K_M.gguf', directory: 'KREA-2_GGUFs', approximateBytes: 7216993376 },
      // Follow this runtime's documented Wan2.1 companion. Other distributions
      // name a Qwen VAE; shared structural classes do not prove identical weights.
      { role: 'vae', repository: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', revision: 'dfcea77bcf258496e20c69cd84e8e8e41909bb3b', path: 'split_files/vae/wan_2.1_vae.safetensors', directory: 'Wan_2.1_ComfyUI_repackaged', approximateBytes: 253815318 },
      { role: 'lm', repository: 'Qwen/Qwen3-VL-4B-Instruct-GGUF', revision: 'bdc46888d3da9c4578c765ca9eb9f5a385a64e6c', path: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', directory: 'Qwen3-VL-4B-Instruct-GGUF', approximateBytes: 2500000000 },
    ],
  },
  {
    id: 'ernie-image-turbo', title: 'ERNIE-Image-Turbo',
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/ernie_image.md',
    files: [
      { role: 'diffusion', repository: 'unsloth/ERNIE-Image-Turbo-GGUF', revision: 'f17197b39ee5f51fff1815a3d245a4b876106230', path: 'ernie-image-turbo-Q4_K_M.gguf', directory: 'ERNIE-Image-Turbo-GGUF', approximateBytes: 5019124416 },
      { role: 'vae', repository: 'Comfy-Org/ERNIE-Image', revision: '82d237fcf02a10b75154717487d07a724a25dc5b', path: 'vae/flux2-vae.safetensors', directory: 'ERNIE-Image', approximateBytes: 336213556 },
      { role: 'lm', repository: 'unsloth/Ministral-3-3B-Instruct-2512-GGUF', revision: '7f116d3df13bc7d3820b2ff1d5c273133b5accaa', path: 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf', directory: 'Ministral-3-3B-Instruct-2512-GGUF', approximateBytes: 2150000000 },
    ],
  },
];

export type ImageRecipeComponent = {
  role: ImageRecipeFile['role'];
  defaultOptionId: string;
  options: readonly (ImageRecipeFile & { id: string })[];
};
export type ImageRecipeSelection = Partial<Record<ImageRecipeFile['role'], string>>;

// Only reviewed files at the pinned revisions are options. A role may have just
// one known option (notably the model-specific VAE); never invent substitutes.
export const imageModelRecipes: readonly ImageModelRecipe[] = reviewedRecipes.map(recipe => ({
  ...recipe,
  components: recipe.files.map(file => {
    const options = [{ ...file, id: 'default' }];
    if (recipe.id === 'z-image-turbo' && file.role === 'diffusion') {
      options.push({ ...file, id: 'q4-0', path: 'z_image_turbo-Q4_0.gguf', approximateBytes: 3680000000 });
      options.push({ ...file, id: 'q8-0', path: 'z_image_turbo-Q8_0.gguf', approximateBytes: 6580000000 });
    }
    if (recipe.id === 'z-image-turbo' && file.role === 'lm') {
      options.push({ ...file, id: 'safetensors', repository: 'Comfy-Org/z_image_turbo', revision: '93fae7d7f6189cc408fdd7cec36c91447b8506a2',
        path: 'split_files/text_encoders/qwen_3_4b.safetensors', directory: 'z_image_turbo', approximateBytes: 8040000000 });
    }
    if (recipe.id === 'qwen-image-2.1' && file.role === 'lm') {
      options.push({ ...file, id: 'q8-0', path: 'Qwen3VL-8B-Instruct-Q8_0.gguf', approximateBytes: 8710000000 });
    }
    return { role: file.role, defaultOptionId: 'default', options };
  }),
}));

/** Selecting options is entirely local; remote existence/size/hash validation
 * happens ONLY after an explicit download request. */
export function selectedRecipeFiles({ recipe, selections }: { recipe: ImageModelRecipe, selections: ImageRecipeSelection }): ImageRecipeFile[] {
  return recipe.components.map(component => {
    const id = selections[component.role] ?? component.defaultOptionId;
    const option = component.options.find(item => item.id === id);
    if (!option) throw new Error('Unknown catalog component option');
    const { id: _id, ...file } = option; return file;
  });
}

/** Ordinary browser navigation, never a background fetch. */
export function imageRecipeLink({ file, action }: { file: Pick<ImageRecipeFile, 'repository' | 'revision' | 'path'>, action: 'download' | 'source' }): string {
  const root = `https://huggingface.co/${file.repository}`;
  const path = file.path.split('/').map(part => encodeURIComponent(part)).join('/');
  switch (action) {
  case 'download': return `${root}/resolve/${file.revision}/${path}?download=true`;
  case 'source': return `${root}/blob/${file.revision}/${path}`;
  default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
  }
}
export function imageRecipeLayout({ recipe }: { recipe: ImageModelRecipe }): string {
  return recipe.files.map(file => `${file.directory}/\n  ${file.path}`).join('\n');
}
export const TEST_ONLY = {
};
