# v0.2.0 — The Confidence Release

v0.2.0 focuses on reliability, release safety, and function-schema compatibility.

## Highlights

- Fixes the `drag` function schema error reported by function-call validators:
  - `Invalid schema for function 'drag': [{'type': 'number'}, {'type': 'number'}] is not of type 'object', 'boolean'`
- Removes tuple-style `drag.path` points from the public tool schemas so generated JSON Schema no longer emits array-form `items`.
- Adds strict TypeScript checking via `npm run typecheck`.
- Adds a schema compatibility regression check via `npm run test:schema`.
- Adds `npm test` as the combined local verification command.
- Adds GitHub Actions CI to run checks on pushes and pull requests.

## Tool schema change

`drag.path` should now be provided as object points:

```json
{
  "path": [
    { "x": 10, "y": 20 },
    { "x": 100, "y": 200 }
  ]
}
```

Tuple-style points such as `[10, 20]` are no longer advertised in the tool schema because they can produce JSON Schema that some function-call providers reject.

## Validation

Validated locally with:

```bash
npm test
```

which runs:

```bash
npm run typecheck
npm run test:schema
```
