import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    coverage: { reporter: ["text", "json"] },
  },
  resolve: { alias: {
    "@": path.resolve(process.cwd(), "src"),
    "server-only": path.resolve(process.cwd(), "tests/fixtures/server-only.ts"),
  } },
});
