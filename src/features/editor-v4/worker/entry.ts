import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createEditorSearchWorker } from './impl';
import type { EditorSearchWorker } from './types';

exposeWorkerRemote<EditorSearchWorker>({ api: createEditorSearchWorker({ runtime: 'worker' }), endpoint: undefined });

export const TEST_ONLY = {
};
