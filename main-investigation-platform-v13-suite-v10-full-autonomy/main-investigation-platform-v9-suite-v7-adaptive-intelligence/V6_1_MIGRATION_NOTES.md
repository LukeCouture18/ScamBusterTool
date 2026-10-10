# v6.1 migration and recovery notes

The ordered baseline is `drizzle/0000` through `drizzle/0007`. The generated D1 binding declares `../../drizzle` as its migration directory. After `npm run build`, `npm start` applies pending local migrations before serving traffic and aborts if migration execution fails. The Worker also returns `SCHEMA_UPGRADE_INCOMPLETE` rather than operating on a partial schema.

Set `MIP_PERSIST_TO` to select an isolated local persistence directory. For hosted deployment, back up the database, apply the same ordered migrations through the controlled remote D1 migration step, validate schema/data counts, then route traffic. Do not use `CREATE TABLE IF NOT EXISTS` as schema evolution.

The matrix passed:

- fresh → v6.1
- v5 → v6.1
- v6 → v6.1
- v6.1 checkpoint → final v6.1
- failure before migration
- failure between migrations
- failure during schema change
- failure after schema change before bookkeeping
- failure during data migration
- restart after interrupted migration

If migration fails, stop workers and the scheduler, preserve the database and migration history, inspect the explicit error, restore the last valid backup when partial changes cannot be safely retried, validate on a copy, then resume. The platform must remain stopped while `assertSchemaReady` fails.
