// drizzle-kit config: `npm run db:generate` writes a SQL migration for changes to src/schema.ts.
// The server applies pending migrations itself at startup (src/db.ts).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/schema.ts",
    out: "./drizzle",
});
