// drizzle-kit config for the desktop app's local database: `npm run db:generate` writes a SQL
// migration for changes to src/repositories/schema.ts. The app applies pending migrations at
// startup (src/repositories/local-database.ts).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/repositories/schema.ts",
    out: "./drizzle",
});
