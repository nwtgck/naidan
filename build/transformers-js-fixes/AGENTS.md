# Marking upstream fixes

- Mark each logical Naidan modification to upstream-derived code with an adjacent English comment starting with `// Naidan fix:`. Explain the reason or failure being prevented, not merely what the code does.
- For transformations defined in `replacements.json`, put the comment in the replacement (`after`) code so it accompanies the fix in the transformed source. Keep `before` text and saved original evidence unchanged. A deletion belonging to an adjacent commented fix does not need a separate marker.
- Use the same prefix when directly modifying an upstream-derived file. Keep its original baseline and the local changes distinguishable; the name `upstream/` alone does not require every future file there to be unmodified.
- Preserve upstream formatting, naming, signatures, and code structure wherever unrelated to the fix. Whole-file lint exemptions are allowed for upstream-derived files to avoid style-only churn; Naidan-owned integration code and tests remain normally linted.
- A short prefixed comment is sufficient. Do not introduce additional source copies or directory layers solely to mark modifications. See `README.md` for provenance, verification, and removal requirements.
