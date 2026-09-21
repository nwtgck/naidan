export const llamaCppBrowser__automatic_profile = ({ profile }: { profile: string | undefined }): string => profile === undefined ? '自動' : `自動 (${profile})`;
