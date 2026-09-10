// These are exact source fragments, not executable replacement functions.
// Keep literal boundaries at the actual first/last byte: String.raw preserves
// backslashes and newlines, including the final newline in the deletion below.
export default [
  {
    before: String.raw`        new Promise(async (resolve, reject) => {
          const data = await getModelFile(
            pretrained_model_name_or_path,
            fullPath,
            true,
            options,
            return_path
          );
          resolve(data instanceof Uint8Array ? { path, data } : path);
        })`,
    after: String.raw`        // Naidan fix: propagate external-data rejection to its owner.
        getModelFile(
          pretrained_model_name_or_path,
          fullPath,
          true,
          options,
          return_path
        ).then((data) => data instanceof Uint8Array ? { path, data } : path)`,
  },
  {
    before: String.raw`  const bufferOrPathPromise = getCoreModelFile(pretrained_model_name_or_path, fileName, options, suffix);
  const use_external_data_format = options.use_external_data_format ?? custom_config.use_external_data_format;
  const externalData = await getModelDataFiles(
    pretrained_model_name_or_path,
    fileName,
    suffix,
    options,
    use_external_data_format,
    session_options
  );`,
    after: String.raw`  const use_external_data_format = options.use_external_data_format ?? custom_config.use_external_data_format;
  // Naidan fix: attach both rejection handlers before awaiting either input.
  const [buffer_or_path, externalData] = await Promise.all([
    getCoreModelFile(pretrained_model_name_or_path, fileName, options, suffix),
    getModelDataFiles(
      pretrained_model_name_or_path,
      fileName,
      suffix,
      options,
      use_external_data_format,
      session_options
    )
  ]);`,
  },
  {
    before: String.raw`  const buffer_or_path = await bufferOrPathPromise;
`,
    after: '',
  },
  {
    before: String.raw`    const sessions = typeConfig.sessions(config, options, textOnly);
    const promises = [
      constructSessions(pretrained_model_name_or_path, sessions, options, typeConfig.cache_sessions)
    ];
    if (typeConfig.optional_configs) {
      promises.push(get_optional_configs(pretrained_model_name_or_path, typeConfig.optional_configs, options));
    }
    const info = await Promise.all(promises);
    return new this(config, ...info);`,
    after: String.raw`    // Naidan fix: finish shared optional metadata before selecting or creating sessions.
    const info = typeConfig.optional_configs
      ? [await get_optional_configs(pretrained_model_name_or_path, typeConfig.optional_configs, options)]
      : [];
    const sessions = typeConfig.sessions(config, options, textOnly);
    info.unshift(await constructSessions(pretrained_model_name_or_path, sessions, options, typeConfig.cache_sessions));
    return new this(config, ...info);`,
  },
  {
    before: String.raw`async function get_optional_configs(pretrained_model_name_or_path, names, options) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(names).map(async (name) => {
        const config = await getModelJSON(pretrained_model_name_or_path, names[name], false, options);
        return [name, config];
      })
    )
  );
}`,
    after: String.raw`async function get_optional_configs(pretrained_model_name_or_path, names, options) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(names).map(async (name) => {
        try {
          const config = await getModelJSON(pretrained_model_name_or_path, names[name], false, options);
          return [name, config];
        } catch (cause) {
          // Naidan fix: retain this consumer's origin without classifying every SyntaxError.
          const description = cause instanceof Error ? cause.name + ": " + cause.message : String(cause);
          const error = new Error("Optional configuration preparation failed for " + names[name] + ": " + description, { cause });
          error.name = "TransformersJsOptionalConfigurationError";
          throw error;
        }
      })
    )
  );
}`,
  },
  {
    before: String.raw`  return template.replace(/{%\s*(end)?generation\s*%}/gs, "");`,
    after: String.raw`  // Naidan fix: generation is syntax, not text to erase inside quoted literals.
  return template;`,
  },
  {
    before: String.raw`      case "filter": {
        ++current;`,
    after: String.raw`      case "generation": {
        // Naidan fix: parse balanced blocks so whitespace controls, nesting and literal contents survive.
        ++current;
        if (!is(TOKEN_TYPES.CloseStatement)) {
          throw new SyntaxError("generation takes no arguments");
        }
        ++current;
        const body = [];
        while (!isStatement("endgeneration")) {
          if (current >= tokens.length) {
            throw new SyntaxError("Expected endgeneration");
          }
          body.push(parseAny());
        }
        expect(TOKEN_TYPES.OpenStatement, "Expected '{%'");
        expectIdentifier("endgeneration");
        if (!is(TOKEN_TYPES.CloseStatement)) {
          throw new SyntaxError("endgeneration takes no arguments");
        }
        ++current;
        // Naidan fix: render the body in the current environment; this does not implement assistant masks.
        result = new Program(body);
        break;
      }
      case "filter": {
        ++current;`,
  },
] satisfies Array<{ before: string, after: string }>;
