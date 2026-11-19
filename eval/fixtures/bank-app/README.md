# bank-app — Sift evaluation fixture

A small TypeScript banking service written to test Sift. It is never run; it only needs to type-check.

- **Third-party libraries are stubbed** in `types/` (`@prisma/client`, `express`, a JSX namespace) so the fixture needs no install or code generation. Stubs mirror the real libraries' shapes closely enough for call resolution and rule packs. Node built-ins come from the repository's `@types/node`.
- **`tests/`** holds Vitest tests for Phase 3. They are not part of `sift.config.yaml`'s `include`.

## Planted problems

| Where | Problem | Expected warning |
|---|---|---|
| `AccountService.transferFunds` | Two balance updates without a database transaction | `missing-transaction` |
| `AccountService.withdraw` | No check that the balance covers the amount | `missing-check` |
| `getBalanceHandler` (`http/routes.ts`) | Returns any account's balance without an ownership check | `missing-auth` |
| `AccountService.transferFunds` | The `transfer.completed` event is emitted without `await` | `unawaited-promise` |
| `AccountService.deposit` | Comment says the limit is $10,000; code allows $100,000 | `comment-contradicts-code` |

## Shapes covered

Interface with two implementations, constructor injection, inline callbacks (`reduce`, `map`, route handler), a small helper, a recursive function, a JSX component, async try/catch, a `switch`, `for…of`, `while`, module-level registration (`app.ts`), an event bus, a plain JavaScript file with inferred types, `fetch`, `fs/promises`, and Prisma calls.
