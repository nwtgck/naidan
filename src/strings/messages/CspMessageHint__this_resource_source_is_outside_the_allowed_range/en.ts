export const CspMessageHint__this_resource_source_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `This resource source${url === undefined ? '' : ` (${url})`} is outside the allowed range.`
);
