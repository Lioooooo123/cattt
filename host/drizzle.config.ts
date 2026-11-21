import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema/index.ts",
  out: "./drizzle",
});
