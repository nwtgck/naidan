export const PromptApiStatus__less_than_required_free_space_on_browser_profile_volume = ({ browser, gigabytes }: { browser: string; gigabytes: number }): string => (
  `Menos de ${gigabytes} GB de espaço livre no volume que contém o perfil do ${browser}.`
);
