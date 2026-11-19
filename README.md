# Sift

Readable, verified descriptions of what your code does, kept in sync with the code.

- [Requirements](requirements.md)
- [Phase 1 design](docs/design.md)

## Development

Requires Node.js 20 or later.

```sh
npm install
npm run verify      # build, type-check (including tests), run tests
npm run sift -- --help
```

| Package | Purpose |
|---|---|
| `packages/core` | Language- and provider-independent engine: config, schema, pipeline, graph |
| `packages/adapter-typescript` | TypeScript/JavaScript language adapter |
| `packages/provider-claude-code` | AI provider using `claude -p` |
| `packages/rules` | Built-in framework rule packs |
| `packages/cli` | The `sift` command |
