import { execFileSync } from "node:child_process";

import { testDatabaseUrl } from "./db";

/** Creates the test database if needed and applies all migrations, once per test run. */
export default function setup() {
  execFileSync("yarn", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: "pipe",
    // On Windows `yarn` is a .cmd script, which Node only starts through a shell.
    shell: process.platform === "win32",
  });
}
