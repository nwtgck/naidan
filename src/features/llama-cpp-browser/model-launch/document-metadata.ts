import type { PageMetadata } from '@/logic/document-metadata';

export function modelLaunchMetadata({ repository, variant }: { repository: string, variant: string | undefined }): PageMetadata {
  const model = repository.split('/').slice(1).join('/');
  return {
    title: `Run ${model} in your browser | Naidan`,
    description: `Run ${repository}${variant === undefined || variant.length === 0 ? '' : ` (${variant})`} locally in your browser with Naidan. Download the model and start chatting. No installation required.`,
  };
}

export const TEST_ONLY = {
};
