export const llamaCppBrowser__automatic_profile = ({ profile }: { profile: string | undefined }): string => profile === undefined ? 'Automático' : `Automático (${profile})`;
