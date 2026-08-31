# Database migrations

OpenCOI keeps an ordered, checksummed migration ledger in
`opencoi_schema_migrations`. The ledger brings the original `PRAGMA
user_version` foundation schema and the later API and integration tables under
one migration history.

Each ledger row records the migration sequence, stable identifier, name,
SHA-256 checksum, UTC application time, duration, and whether OpenCOI applied
the change or adopted an already-complete schema. Checksums are derived from
the immutable SQL definition for that migration. A changed checksum, unknown
future ledger row, ledger gap, newer `user_version`, missing recorded object,
or foreign-key violation stops startup and the CLI rather than guessing.

## Commands

From a source checkout, the configured `DATABASE_PATH` is used by default:

```sh
npm run db:migrate -- --plan
npm run db:migrate -- --check
npm run db:migrate
```

Use `--database /absolute/path/to/opencoi.sqlite` to inspect or migrate a
specific database. `--plan` and `--check` open an existing target read-only.
When the target does not exist, they model an empty database in memory and do
not create the target file. `--check` exits with status 1 when an apply or
adoption action remains; `--plan` reports the same work and exits successfully.

For the production container, which contains compiled JavaScript rather than
the TypeScript development runner, use:

```sh
node dist/server/cli/migrate.js --plan
node dist/server/cli/migrate.js --check
node dist/server/cli/migrate.js
```

## Existing installations

The first migration run against a complete v0.3 database verifies its physical
tables, indexes, triggers, required columns, `user_version`, and foreign keys,
then records those migrations as `adopted`. Adoption does not rewrite
application rows. An incomplete legacy schema is repaired only by the existing
idempotent migration assigned to that ledger entry and is verified before the
entry is recorded.

Normal web and worker startup still invokes the same migration runner for
backward compatibility. Operators should nevertheless run `--plan`, take a
verified stopped-service backup, and run the explicit migration command during
an upgrade window. Do not start two release versions against one SQLite file.

## Failure and rollback

Transactional migrations write their schema change and ledger row in one
`BEGIN IMMEDIATE` transaction. The historical requirement-table rebuild must
temporarily disable foreign-key enforcement, so it owns a separate immediate
transaction, rolls back on failure, restores enforcement, and is recorded only
after structural and foreign-key checks pass. A crash after that rebuild but
before its ledger insert is safe: the next run verifies and adopts the completed
schema.

Do not edit ledger rows or previously released migration definitions. If a
migration fails:

1. Keep the application and outbound workers stopped.
2. Save the exact error and run `--plan` against a copy for diagnosis.
3. Correct environmental causes such as permissions or free space, then retry.
4. If application schema or data must be rolled back, restore the complete
   pre-upgrade data backup; changing `user_version` or deleting ledger rows is
   not a rollback.

After migration, `--check` must pass before enabling traffic or outbound
workers. A release rollback is safe only when its release notes declare the
schema compatible; otherwise restore the backup made by that older release.
