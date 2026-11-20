# Built-in rule packs

One YAML file per pack. Format: [design §9](../../../docs/design.md#9-framework-rule-packs).

| Pack | Applies when | Gives |
|---|---|---|
| `prisma` | `@prisma/client` is a dependency | `db.read`, `db.write`, `db.transaction` |
| `node-fs` | always | `fs.read`, `fs.write` |
| `node-child-process` | always | `process.exec` |
| `fetch` | always | `net.request` |
| `console` | always | `log` |
| `express` | `express` is a dependency | `handles-route` edges |

Projects add their own packs in `.sift/rules/*.yaml`; they are loaded after these.
