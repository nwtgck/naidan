// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { imageModelRecipes, imageRecipeLayout, imageRecipeLink, selectedRecipeFiles } from './model-recipes';
import { imageDownloadSourceSchema, imageFileIdentity, imageFileIdentitySchema } from './logic/catalog-source';
import type { CatalogFetch } from './download-worker/fetch-types';
import { validModelPath } from './logic/model-path';
import { scanImageRepositories } from './logic/model-candidates';
import { ggufFixture, safetensorsFixture, zImageTensors, qwenImageTensors, fluxVaeTensors, qwenVaeTensors, qwenTextTensors, sdCheckpointTensors, sdVaeTensors, flux2KleinTensors, flux2VaeTensors, animaTensors, wanVaeTensors, krea2Tensors, ernieImageTensors, ministralTextTensors } from './test-utils/weights';

it('lists revision-pinned component and checkpoint recipes with original inner paths', () => {
  expect(imageModelRecipes.map(recipe => recipe.id)).toEqual(['z-image-turbo', 'qwen-image-2.1', 'qwen-image-2.1-turbo', 'z-image-base', 'sdxl-base-1.0', 'flux2-klein-4b', 'anima-turbo-1.1', 'krea2-turbo', 'ernie-image-turbo']);
  for (const recipe of imageModelRecipes) {
    const sdxl = recipe.id === 'sdxl-base-1.0';
    expect(recipe.files.map(file => file.role)).toEqual(sdxl ? ['model', 'vae'] : ['diffusion', 'vae', 'lm']);
    expect(new Set(recipe.files.map(file => file.repository)).size).toBe(recipe.id === 'anima-turbo-1.1' ? 1 : sdxl || recipe.id === 'flux2-klein-4b' ? 2 : 3);
    expect(new Set(recipe.files.map(file => `${file.repository}/${file.path}`)).size).toBe(recipe.files.length);
    for (const file of recipe.files) {
      if (recipe.id === 'qwen-image-2.1-turbo' && file.role === 'diffusion') {
        // Temporary test-only source revision until Abiray's SHA is verified.
        expect(file.revision).toBe('main');
      } else expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
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

it('limits the provisional main revision to the six known Abiray Turbo weights', () => {
  const turbo = imageModelRecipes.find(recipe => recipe.id === 'qwen-image-2.1-turbo')!;
  const diffusion = turbo.components.find(component => component.role === 'diffusion')!;
  for (const option of diffusion.options) {
    expect(imageDownloadSourceSchema.parse(option)).toMatchObject({ repository: option.repository, revision: 'main', path: option.path });
    expect(imageFileIdentitySchema.parse({ ...option, size: 8, sha256: 'a'.repeat(64) }).revision).toBe('main');
  }
  const valid = diffusion.options[0]!;
  for (const invalid of [
    { ...valid, repository: 'other/model' },
    { ...valid, path: 'other_file.gguf' },
    { ...valid, revision: 'next' },
  ]) {
    expect(() => imageDownloadSourceSchema.parse(invalid)).toThrow();
    expect(() => imageFileIdentitySchema.parse({ ...invalid, size: 8, sha256: 'a'.repeat(64) })).toThrow();
  }
});

it('defaults Qwen Image 2.1 Turbo to Abiray Q4_K_M and switches only its diffusion file', () => {
  const turbo = imageModelRecipes.find(recipe => recipe.id === 'qwen-image-2.1-turbo')!;
  const base = imageModelRecipes.find(recipe => recipe.id === 'qwen-image-2.1')!;
  expect(turbo.recommendation).toBeUndefined();
  expect(turbo.source).toBe('https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo');
  const diffusion = turbo.components.find(component => component.role === 'diffusion')!;
  expect(diffusion.defaultOptionId).toBe('default');
  expect(diffusion.options.map(option => [option.id, option.path, option.approximateBytes])).toEqual([
    ['default', 'qwen_image_2.1_turbo_Q4_K_M.gguf', 4190000000],
    ['q3-k-m', 'qwen_image_2.1_turbo_Q3_K_M.gguf', 3190000000],
    ['q4-k-s', 'qwen_image_2.1_turbo_Q4_K_S.gguf', 4060000000],
    ['q5-k-m', 'qwen_image_2.1_turbo_Q5_K_M.gguf', 5010000000],
    ['q6-k', 'qwen_image_2.1_turbo_Q6_K.gguf', 5880000000],
    ['q8-0', 'qwen_image_2.1_turbo_Q8_0.gguf', 7590000000],
  ]);
  expect(diffusion.options.every(option => option.repository === 'Abiray/Qwen-Image-2.1-Turbo-GGUF' && option.revision === 'main')).toBe(true);
  const defaultFiles = selectedRecipeFiles({ recipe: turbo, selections: {} });
  expect(defaultFiles).toEqual(turbo.files);
  expect(defaultFiles.slice(1)).toEqual(base.files.slice(1));
  for (const option of diffusion.options) {
    const selected = selectedRecipeFiles({ recipe: turbo, selections: { diffusion: option.id } });
    expect(selected[0]).toEqual({ repository: option.repository, revision: option.revision, path: option.path, role: option.role, directory: option.directory, approximateBytes: option.approximateBytes });
    expect(selected.slice(1)).toEqual(defaultFiles.slice(1));
  }
  expect(turbo.components.find(component => component.role === 'lm')?.options.map(option => option.id)).toEqual(['default', 'q8-0']);
  expect(() => selectedRecipeFiles({ recipe: turbo, selections: { diffusion: 'wrong-quant' } })).toThrow('Unknown catalog component option');
});

// Actual repository filenames with synthetic tensor metadata. This proves the
// import/recognition recipe mapping, NOT compatibility of trained weights/GPU.
it('recognizes every catalog layout without flattening paths or merging repositories', async () => {
  for (const recipe of imageModelRecipes) {
    const facts = (() => {
      switch (recipe.id) {
      case 'z-image-turbo': case 'z-image-base': return { family: 'z-image', diffusion: zImageTensors, vae: fluxVaeTensors, vaeClass: 'vae-flux16', architecture: 'qwen3', width: 2560, layers: 36, lmClass: 'lm-qwen3-4b' };
      case 'qwen-image-2.1': case 'qwen-image-2.1-turbo': return { family: 'qwen-image-2.1', diffusion: qwenImageTensors, vae: qwenVaeTensors, vaeClass: 'vae-qwen21', architecture: 'qwen3vl', width: 4096, layers: 36, lmClass: 'lm-qwen3vl-8b' };
      case 'sdxl-base-1.0': return { family: 'sd-checkpoint', diffusion: sdCheckpointTensors, vae: sdVaeTensors, vaeClass: 'vae-sd4', architecture: '', width: 0, layers: 0, lmClass: '' };
      case 'flux2-klein-4b': return { family: 'flux2-klein-4b', diffusion: flux2KleinTensors, vae: flux2VaeTensors, vaeClass: 'vae-flux32', architecture: 'qwen3', width: 2560, layers: 36, lmClass: 'lm-qwen3-4b' };
      case 'anima-turbo-1.1': return { family: 'anima', diffusion: animaTensors, vae: wanVaeTensors, vaeClass: 'vae-wan16', architecture: 'qwen3', width: 1024, layers: 28, lmClass: 'lm-qwen3-06b' };
      case 'krea2-turbo': return { family: 'krea2', diffusion: krea2Tensors, vae: wanVaeTensors, vaeClass: 'vae-wan16', architecture: 'qwen3vl', width: 2560, layers: 36, lmClass: 'lm-qwen3vl-4b' };
      case 'ernie-image-turbo': return { family: 'ernie-image', diffusion: ernieImageTensors, vae: flux2VaeTensors, vaeClass: 'vae-flux32', architecture: 'mistral3', width: 3072, layers: 26, lmClass: 'lm-ministral3-3b' };
      default: { const exhaustive: never = recipe.id; throw new Error(String(exhaustive)); }
      }
    })();
    const sdxl = recipe.id === 'sdxl-base-1.0';
    const repositories = recipe.files.map(entry => {
      const name = entry.path.split('/').at(-1)!;
      const file = entry.role === 'model' ? safetensorsFixture({ name, tensors: sdCheckpointTensors }).file : entry.role === 'vae'
        ? safetensorsFixture({ name, tensors: facts.vae }).file
        : ggufFixture({ name, tensors: entry.role === 'diffusion' ? facts.diffusion : facts.architecture === 'mistral3' ? ministralTextTensors : qwenTextTensors({ width: facts.width, layers: facts.layers }), metadata: entry.role === 'lm' ? { 'general.architecture': facts.architecture } : {}, extraBytes: 0 }).file;
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

it('discovers the ERNIE default using the case-sensitive path in its pinned repository tree', async () => {
  // Minimal entry from the pinned HF tree, independent of recipe-generated fixtures.
  const published = {
    type: 'file',
    path: 'ernie-image-turbo-Q4_K_M.gguf',
    size: 5019124416,
    lfs: { size: 5019124416, oid: 'ed3e035b631da47b0469b314dcce0afc3618fc9386f1af3d3e28710181e21d93' },
  };
  const recipe = imageModelRecipes.find(recipe => recipe.id === 'ernie-image-turbo')!;
  const file = selectedRecipeFiles({ recipe, selections: {} }).find(file => file.role === 'diffusion')!;
  const fetch = vi.fn<CatalogFetch>(async () => ({
    url: '',
    status: 200,
    statusText: 'OK',
    ok: true,
    redirected: false,
    responseType: 'basic',
    headers: new Headers(),
    policyName: 'huggingface_models',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify([published]))); controller.close();
      },
    }),
  }));
  const identity = await imageFileIdentity({ file, signal: new AbortController().signal, fetch });
  expect(identity).toEqual({
    repository: 'unsloth/ERNIE-Image-Turbo-GGUF',
    revision: 'f17197b39ee5f51fff1815a3d245a4b876106230',
    path: published.path,
    size: published.size,
    sha256: published.lfs.oid,
  });
  expect(fetch.mock.calls[0]![0].request.url).toBe('https://huggingface.co/api/models/unsloth/ERNIE-Image-Turbo-GGUF/tree/f17197b39ee5f51fff1815a3d245a4b876106230?recursive=false&expand=false&limit=1000');
  expect(imageRecipeLink({ file, action: 'download' })).toBe('https://huggingface.co/unsloth/ERNIE-Image-Turbo-GGUF/resolve/f17197b39ee5f51fff1815a3d245a4b876106230/ernie-image-turbo-Q4_K_M.gguf?download=true');
});
