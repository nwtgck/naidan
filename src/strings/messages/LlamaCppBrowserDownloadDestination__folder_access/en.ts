export const LlamaCppBrowserDownloadDestination__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: 'Read and write access',
  read: 'Write permission needed',
  prompt: 'Permission expired; reconnect',
  missing: 'Select the folder again',
  error: 'Folder unavailable',
  unsupported: 'Unavailable in this browser or build',
})[access];
