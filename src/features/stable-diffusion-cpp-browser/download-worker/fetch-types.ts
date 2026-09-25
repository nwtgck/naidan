import type { PrivacyFetchRequest, PrivacyFetchStreamResponse } from '@/features/privacy-fetch/types';
import type { WorkerTransfer } from '@/utils/worker-transport';
export type CatalogFetch = ({ request }: { request: PrivacyFetchRequest }) => Promise<PrivacyFetchStreamResponse>;
export type ImageDownloadFetch = ({ request }: { request: Omit<PrivacyFetchRequest, 'signal'> }) => Promise<WorkerTransfer<MessagePort>>;
export const TEST_ONLY = {
};
