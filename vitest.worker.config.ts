import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            CLOUDFLARE_API_TOKEN: "test-token",
            CONFIG_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
            ACCESS_AUD: "test-audience",
          },
        },
      }),
    ],
    test: {
      include: ["tests/worker/**/*.test.ts"],
      setupFiles: ["./tests/worker/setup.ts"],
      sequence: { concurrent: false },
    },
  };
});
