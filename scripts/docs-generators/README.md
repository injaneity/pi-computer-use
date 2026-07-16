# Documentation generators

Every reader-facing reference page is generated so reference ownership stays with the code and repository structures it describes.

```bash
npm run docs:generate  # rewrite generated files
npm run docs:check     # fail on output, source-block, citation, or evidence drift
```

## Tool schemas

`generate-tool-reference.mjs` statically evaluates the TypeBox declarations passed to `defineTool` in `extensions/computer-use.ts`. It emits exact descriptions, agent guidance, parameters, required fields, constraints, and action variants without loading the extension or native helper.

## Source-owned behavioral references

`generate-source-references.mjs` extracts Markdown blocks delimited by:

```text
PI_DOCS_REFERENCE_BEGIN <page-key>
...
PI_DOCS_REFERENCE_END
```

The block lives in the source file that owns the behavior. `reference-evidence.json` independently maps each output to that source file, lists symbols that must still exist, and can require authored citation URLs. Generation fails when a block, source file, evidence symbol, or required citation disappears. External API citations remain explicitly maintained inside the source-owned block; the generator validates but does not invent them.

The same generator substitutes configuration defaults directly from `DEFAULT_CONFIG`, derives reference indexes and navigation metadata from its page map, and derives the codebase inventory from the repository tree and `package.json`.

## Ownership rules

- Never edit `docs/content/docs/reference/**/*.mdx` directly.
- Put exact interface and implementation behavior in a source-owned reference block.
- Put evidence symbols and source ownership in `reference-evidence.json`.
- Put conceptual rationale in `docs/content/docs/explanation/`.
- Put procedures in tutorials or how-to guides.
- Run generation and commit both source and generated output.
