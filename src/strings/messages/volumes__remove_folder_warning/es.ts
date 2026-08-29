export const volumes__remove_folder_warning = ({ name }: { name: string }): string => (
  `¿Seguro que quieres quitar «${name}»? Dejará de usarse, pero los archivos originales no se verán afectados.`
);
