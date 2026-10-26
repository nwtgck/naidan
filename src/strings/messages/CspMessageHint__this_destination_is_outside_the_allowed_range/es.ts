export const CspMessageHint__this_destination_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `This destination${url === undefined ? '' : ` (${url})`} is outside the allowed range.`
);
