/**
 * index.ts - whatsapp/src/db/index.ts
 *
 * Re-export of the shared Postgres layer.
 *
 * The connection, the schema files and ensureSchema() moved to shared/db so
 * both bots talk to exactly the same database. This shim exists so the dozen
 * modules that already `import sql from "../db/index.js"` keep working - there
 * is nothing WhatsApp-specific left here.
 *
 * The .sql files that used to live in this folder are now in shared/db/.
 */

import sql, { ensureSchema, pingDatabase } from "../../../shared/db/index.js";

export default sql;
export { ensureSchema, pingDatabase };
