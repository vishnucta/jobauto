import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POSTGRES_SCHEMA, SQLITE_SCHEMA, sqliteSchema } from "./derive";

describe("sqliteSchema", () => {
  it("is what prisma/sqlite/schema.prisma holds (run `yarn sqlite-schema` after changing the schema)", () => {
    expect(readFileSync(SQLITE_SCHEMA, "utf8").replace(/\r\n/g, "\n")).toBe(sqliteSchema(readFileSync(POSTGRES_SCHEMA, "utf8")));
  });

  it("refuses a PostgreSQL type it doesn't know", () => {
    const schema = readFileSync(POSTGRES_SCHEMA, "utf8").replace("key       String   @id", "key       String   @id @db.Uuid");
    expect(() => sqliteSchema(schema)).toThrow("SQLite has no @db.Uuid");
  });

  // The schema has no list of values since the fork's PostingSearch.sources
  // went into upstream's `portals` (1.15 merge), so these add some to a copy.
  const ADDED_BY = '  addedBy         String        @default("")\n';
  const postgres = () => readFileSync(POSTGRES_SCHEMA, "utf8").replace(/\r\n/g, "\n");

  it("makes a list of values that starts empty a JSON array, and leaves relations alone", () => {
    expect(postgres()).toContain(ADDED_BY);
    const schema = sqliteSchema(postgres().replace(ADDED_BY, `${ADDED_BY}  kinds           ContactKind[] @default([])\n  words           String[]      @default([])\n`));
    expect(schema).toContain('  kinds           Json          @default("[]")\n');
    expect(schema).toContain('  words           Json          @default("[]")\n');
    expect(schema).toContain("  events      RecruiterEvent[]\n");
    expect(schema).not.toMatch(/^ +\w+ +(String|ContactKind)\[\]/m);
  });

  it("refuses a list of values it can't make a JSON array", () => {
    const schema = postgres().replace(ADDED_BY, `${ADDED_BY}  kinds           ContactKind[]\n`);
    expect(() => sqliteSchema(schema)).toThrow('SQLite has no lists of values: say in prisma/sqlite/derive.ts what "kinds           ContactKind[]" becomes.');
  });
});

describe("the SQLite migrations", () => {
  it("make exactly prisma/sqlite/schema.prisma (make a migration for SQLite too, see DEVELOPMENT.md)", () => {
    // `migrate diff --exit-code` exits with 2, and lists the difference, when there is one.
    const diff = spawnSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-migrations", "prisma/sqlite/migrations", "--to-schema", SQLITE_SCHEMA, "--exit-code"],
      { encoding: "utf8" },
    );
    expect(diff.status, diff.stdout + diff.stderr).toBe(0);
  }, 30_000);
});
