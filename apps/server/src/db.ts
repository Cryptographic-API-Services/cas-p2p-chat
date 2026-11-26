import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as path from "node:path";
import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import * as schema from "./schema.ts";

/** Either driver's database: node-postgres in production, PGlite for local runs and tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
    db: Database;
    /** Where the data lives, for the startup log (never includes credentials). */
    description: string;
    close(): Promise<void>;
}

const MIGRATIONS = path.join(import.meta.dirname, "..", "drizzle");

/**
 * Opens the directory database and applies pending migrations (drizzle/).
 *
 *   postgres://… or postgresql://…   PostgreSQL (use ?sslmode=verify-full for a remote server)
 *   pglite:memory                     embedded PGlite, in memory (tests, smoke test)
 *   pglite:<directory>                embedded PGlite, stored in that directory (local runs)
 *
 * `password`, for PostgreSQL only, supplies the password for each new connection instead of the
 * URL (a managed identity's Entra ID token; see managed-identity.ts).
 */
export async function openDatabase(url: string, password?: () => Promise<string>): Promise<DatabaseHandle> {
    if (/^postgres(ql)?:\/\//.test(url)) {
        // Parsed here rather than passed as connectionString: pg would let the URL's (empty)
        // password override the password function.
        const pool = new pg.Pool({ ...parseIntoClientConfig(url), max: 10, ...(password ? { password } : {}) });
        // An idle connection dropped by the server would otherwise crash the process.
        pool.on("error", (err) => console.error(`PostgreSQL connection error: ${err.message}`));
        const db = drizzlePg(pool, { schema });
        await migratePg(db, { migrationsFolder: MIGRATIONS });
        const { host, pathname } = new URL(url);
        return { db, description: `PostgreSQL ${host}${pathname}`, close: () => pool.end() };
    }
    if (url.startsWith("pglite:")) {
        const dir = url.slice("pglite:".length);
        const client = new PGlite(dir === "memory" ? "memory://" : path.resolve(dir));
        const db = drizzlePglite(client, { schema });
        await migratePglite(db, { migrationsFolder: MIGRATIONS });
        return { db, description: dir === "memory" ? "PGlite (in memory)" : `PGlite in ${path.resolve(dir)}`, close: () => client.close() };
    }
    throw new Error("DATABASE_URL must start with postgres://, postgresql:// or pglite:");
}
