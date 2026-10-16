import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { docsBuildConfig } from './build/production';

export default defineConfig(docsBuildConfig({ root: fileURLToPath(new URL('.', import.meta.url)) }));
