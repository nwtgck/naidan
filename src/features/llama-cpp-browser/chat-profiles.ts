import { z } from 'zod';

export const chatProfileSchema = z.enum(['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'cpu-wasm32']);
export type ChatProfile = z.infer<typeof chatProfileSchema>;

export const TEST_ONLY = {
};
