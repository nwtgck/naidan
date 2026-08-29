export const SettingsModal__successfully_imported_recipes_as_chat_groups = ({ recipeCount }: { recipeCount: number }): string => recipeCount === 1
  ? 'Se importó correctamente 1 receta como grupo de chats'
  : `Se importaron correctamente ${recipeCount} recetas como grupos de chats`;
