export const SettingsModal__successfully_imported_recipes_as_chat_groups = ({ recipeCount }: { recipeCount: number }): string => recipeCount === 1
  ? '1 Rezept wurde erfolgreich als Chatgruppe importiert'
  : `${recipeCount} Rezepte wurden erfolgreich als Chatgruppen importiert`;
