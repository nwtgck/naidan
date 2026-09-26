// @vitest-environment node
import { expect, it } from 'vitest';
import { imageModelRecipes, imageRecipeLayout, imageRecipeLink } from './model-recipes';
import { validModelPath } from './logic/model-path';
import { scanImageRepositories } from './logic/model-candidates';
import { ggufFixture, safetensorsFixture, zImageTensors, qwenImageTensors, fluxVaeTensors, qwenVaeTensors, qwenTextTensors } from './test-utils/weights';

it('lists exactly two three-repository, revision-pinned recipes with original inner paths', () => {
  expect(imageModelRecipes.map(recipe => recipe.id)).toEqual(['z-image-turbo', 'qwen-image-2.1']);
  for (const recipe of imageModelRecipes) {
    expect(recipe.files.map(file => file.role)).toEqual(['diffusion', 'vae', 'lm']);
    expect(new Set(recipe.files.map(file => file.repository)).size).toBe(3);
    for (const file of recipe.files) {
      expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(validModelPath({ path: file.path })).toBe(true);
      expect(file.path).not.toContain('00001-of');
      expect(imageRecipeLink({ file, action: 'download' })).toBe(`https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path}?download=true`);
      expect(imageRecipeLink({ file, action: 'source' })).toBe(`https://huggingface.co/${file.repository}/blob/${file.revision}/${file.path}`);
      expect(imageRecipeLayout({ recipe })).toContain(`${file.directory}/\n  ${file.path}`);
    }
  }
  expect(imageModelRecipes[0]!.files[1]!.path).toBe('split_files/vae/ae.safetensors');
  expect(imageModelRecipes[1]!.files[1]!.path).toBe('vae/qwen_image_2.1_vae_bf16.safetensors');
});

// Actual repository filenames with synthetic tensor metadata. This proves the
// import/recognition recipe mapping, NOT compatibility of trained weights/GPU.
it('recognizes both catalog layouts without flattening paths or merging repositories', async () => {
  for (const recipe of imageModelRecipes) {
    const qwen = recipe.id === 'qwen-image-2.1';
    const repositories = recipe.files.map(entry => {
      const name = entry.path.split('/').at(-1)!;
      const file = entry.role === 'vae'
        ? safetensorsFixture({ name, tensors: qwen ? qwenVaeTensors : fluxVaeTensors }).file
        : ggufFixture({ name, tensors: entry.role === 'diffusion' ? (qwen ? qwenImageTensors : zImageTensors) : qwenTextTensors({ width: qwen ? 4096 : 2560, layers: 36 }), metadata: entry.role === 'lm' ? { 'general.architecture': qwen ? 'qwen3vl' : 'qwen3' } : {}, extraBytes: 0 }).file;
      return { id: `user/${entry.directory}`, name: entry.directory, files: [{ path: entry.path, file }] };
    });
    const inventory = await scanImageRepositories({ repositories, signal: undefined });
    expect(inventory.issues).toEqual([]);
    expect(inventory.candidates.find(candidate => candidate.roles.includes('diffusion'))?.family).toBe(qwen ? 'qwen-image-2.1' : 'z-image');
    expect(inventory.candidates.find(candidate => candidate.roles.includes('vae'))?.classes).toContain(qwen ? 'vae-qwen21' : 'vae-flux16');
    expect(inventory.candidates.find(candidate => candidate.roles.includes('lm'))?.classes).toContain(qwen ? 'lm-qwen3vl-8b' : 'lm-qwen3-4b');
  }
});
