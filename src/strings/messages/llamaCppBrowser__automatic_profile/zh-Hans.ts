export const llamaCppBrowser__automatic_profile = ({ profile }: { profile: string | undefined }): string => profile === undefined ? '自动' : `自动 (${profile})`;
