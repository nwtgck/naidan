export const PromptApiStatus__less_than_required_free_space_on_browser_profile_volume = ({ browser, gigabytes }: { browser: string; gigabytes: number }): string => (
  `Weniger als ${gigabytes} GB freier Speicher auf dem Volume mit deinem ${browser}-Profil.`
);
