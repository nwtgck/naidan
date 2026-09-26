/** Static acquisition recipes, not a remote model catalog or an inference
 * compatibility database. Opening/expanding the catalog performs no I/O.
 * Repository revisions were checked on 2026-09-25. Quantized weights are
 * publisher-provided files; Naidan never asks the user to convert or re-split.
 * Keep paths relative to EACH repository, including split_files/ and vae/.
 */
export type ImageRecipeFile = {
  role: 'diffusion' | 'vae' | 'lm';
  repository: string;
  revision: string;
  path: string;
  directory: string;
  approximateBytes: number;
};
export type ImageModelRecipe = {
  id: 'z-image-turbo' | 'qwen-image-2.1';
  title: string;
  files: readonly ImageRecipeFile[];
  components: readonly ImageRecipeComponent[];
  source: string;
};

const reviewedRecipes: readonly Omit<ImageModelRecipe, 'components'>[] = [
  {
    id: 'z-image-turbo', title: 'Z-Image-Turbo',
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
    source: 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/docs/qwen_image_2.1.md',
    files: [
      { role: 'diffusion', repository: 'leejet/Qwen-Image-2.1-GGUF', revision: '9db551d8368b5d1aa0b93cfe46cd54bb4750eae1', path: 'qwen_image_2.1-Q4_K.gguf', directory: 'Qwen-Image-2.1-GGUF', approximateBytes: 4200000000 },
      { role: 'vae', repository: 'Comfy-Org/Qwen-Image-2.1', revision: '8150226f50722886a275fa08e7b1fdf961732502', path: 'vae/qwen_image_2.1_vae_bf16.safetensors', directory: 'Qwen-Image-2.1', approximateBytes: 676000000 },
      { role: 'lm', repository: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', revision: '00e7d63528e65d7b64e80e1293a8360b4af6a594', path: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', directory: 'Qwen3-VL-8B-Instruct-GGUF', approximateBytes: 5030000000 },
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
export function imageRecipeLink({ file, action }: { file: ImageRecipeFile, action: 'download' | 'source' }): string {
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
