// @vitest-environment node
import { expect, it } from 'vitest';
import { imageModelRecipes, imageRecipeLayout, imageRecipeLink } from './model-recipes';
import { validModelPath } from './logic/model-path';
import { scanImageRepositories } from './logic/model-candidates';
import { ggufFixture, safetensorsFixture, zImageTensors, qwenImageTensors, fluxVaeTensors, qwenVaeTensors, qwenTextTensors, sdCheckpointTensors, sdVaeTensors, flux2KleinTensors, flux2VaeTensors, animaTensors, wanVaeTensors } from './test-utils/weights';

it('lists revision-pinned component and checkpoint recipes with original inner paths', () => {
  expect(imageModelRecipes.map(recipe => recipe.id)).toEqual(['z-image-turbo', 'qwen-image-2.1', 'z-image-base', 'sdxl-base-1.0', 'flux2-klein-4b', 'anima-turbo-1.1']);
  for (const recipe of imageModelRecipes) {
    const sdxl = recipe.id === 'sdxl-base-1.0';
    expect(recipe.files.map(file => file.role)).toEqual(sdxl ? ['model', 'vae'] : ['diffusion', 'vae', 'lm']);
    expect(new Set(recipe.files.map(file => file.repository)).size).toBe(recipe.id === 'anima-turbo-1.1' ? 1 : sdxl || recipe.id === 'flux2-klein-4b' ? 2 : 3);
    expect(new Set(recipe.files.map(file => `${file.repository}/${file.path}`)).size).toBe(recipe.files.length);
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
it('recognizes every catalog layout without flattening paths or merging repositories', async () => {
  for (const recipe of imageModelRecipes) {
    const facts = (() => {
      switch (recipe.id) {
      case 'z-image-turbo': case 'z-image-base': return { family: 'z-image', diffusion: zImageTensors, vae: fluxVaeTensors, vaeClass: 'vae-flux16', architecture: 'qwen3', width: 2560, layers: 36, lmClass: 'lm-qwen3-4b' };
      case 'qwen-image-2.1': return { family: 'qwen-image-2.1', diffusion: qwenImageTensors, vae: qwenVaeTensors, vaeClass: 'vae-qwen21', architecture: 'qwen3vl', width: 4096, layers: 36, lmClass: 'lm-qwen3vl-8b' };
      case 'sdxl-base-1.0': return { family: 'sd-checkpoint', diffusion: sdCheckpointTensors, vae: sdVaeTensors, vaeClass: 'vae-sd4', architecture: '', width: 0, layers: 0, lmClass: '' };
      case 'flux2-klein-4b': return { family: 'flux2-klein-4b', diffusion: flux2KleinTensors, vae: flux2VaeTensors, vaeClass: 'vae-flux32', architecture: 'qwen3', width: 2560, layers: 36, lmClass: 'lm-qwen3-4b' };
      case 'anima-turbo-1.1': return { family: 'anima', diffusion: animaTensors, vae: wanVaeTensors, vaeClass: 'vae-wan16', architecture: 'qwen3', width: 1024, layers: 28, lmClass: 'lm-qwen3-06b' };
      default: { const exhaustive: never = recipe.id; throw new Error(String(exhaustive)); }
      }
    })();
    const sdxl = recipe.id === 'sdxl-base-1.0';
    const repositories = recipe.files.map(entry => {
      const name = entry.path.split('/').at(-1)!;
      const file = entry.role === 'model' ? safetensorsFixture({ name, tensors: sdCheckpointTensors }).file : entry.role === 'vae'
        ? safetensorsFixture({ name, tensors: facts.vae }).file
        : ggufFixture({ name, tensors: entry.role === 'diffusion' ? facts.diffusion : qwenTextTensors({ width: facts.width, layers: facts.layers }), metadata: entry.role === 'lm' ? { 'general.architecture': facts.architecture } : {}, extraBytes: 0 }).file;
      return { id: `user/${entry.directory}`, name: entry.directory, files: [{ path: entry.path, file }] };
    });
    const inventory = await scanImageRepositories({ repositories, signal: undefined });
    expect(inventory.issues).toEqual([]);
    expect(inventory.candidates.find(candidate => candidate.roles.includes(sdxl ? 'model' : 'diffusion'))?.family).toBe(facts.family);
    expect(inventory.candidates.find(candidate => candidate.family === 'unknown' && candidate.roles.includes('vae'))?.classes).toContain(facts.vaeClass);
    if (!sdxl) expect(inventory.candidates.find(candidate => candidate.roles.includes('lm'))?.classes).toContain(facts.lmClass);
    else expect(inventory.candidates.some(candidate => candidate.roles.includes('lm'))).toBe(false);
  }
});
