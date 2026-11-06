import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from src/db/schema.ts. Generation needs no database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
