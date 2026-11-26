import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const FOLDER = "prisma/sqlite/migrations";
const MIGRATIONS = readdirSync(FOLDER, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Runs the migrations from `from` up to, not including, `until`, one file at a time and outside a transaction, as the desktop app does. */
function migrate(db: DatabaseSync, from: string, until = "~") {
  for (const name of MIGRATIONS.filter((name) => name >= from && name < until)) {
    db.exec(readFileSync(path.join(FOLDER, name, "migration.sql"), "utf8"));
  }
}

const one = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as Record<string, unknown> | undefined;

describe("the SQLite migrations", () => {
  // Public issue 167: a bare `DEFAULT []` is stored as '', which isn't JSON, and every search from before 1.15 got it.
  it("leave valid JSON in a search from before 1.15, and keep what it found", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrate(db, "", "20261115100000_positions_library");
      db.exec(`INSERT INTO "PostingSearch" ("id", "source", "query", "postings", "updatedAt") VALUES ('old', 'ADZUNA', '{"keywords":"Designer"}', '[]', CURRENT_TIMESTAMP)`);

      migrate(db, "20261115100000_positions_library", "20261126100000_json_array_defaults");
      // The jobauto fork's 20261126000000_jobauto_after_portals already turns the empty text into a list.
      expect(one(db, `SELECT "portals" FROM "PostingSearch" WHERE "id" = 'old'`)).toEqual({ portals: "[]" });
      db.exec(`UPDATE "PostingSearch" SET "portals" = '', "addedBy" = 'Claude Code' WHERE "id" = 'old'`);
      db.exec(`INSERT INTO "Posting" ("id", "source", "externalId", "updatedAt") VALUES ('p', 'ADZUNA', '1', CURRENT_TIMESTAMP)`);
      db.exec(`INSERT INTO "PostingFind" ("id", "postingId", "searchId", "portal") VALUES ('f', 'p', 'old', 'ADZUNA')`);
      db.exec(`INSERT INTO "PortalCatalog" ("id") VALUES (1)`);

      migrate(db, "20261126100000_json_array_defaults");
      expect(one(db, `SELECT "portals", "postings", "addedBy" FROM "PostingSearch" WHERE "id" = 'old'`)).toEqual({ portals: "[]", postings: "[]", addedBy: "Claude Code" });
      expect(one(db, `SELECT "portals", "withdrawn" FROM "PortalCatalog"`)).toEqual({ portals: "[]", withdrawn: "[]" });
      expect(one(db, `SELECT "searchId" FROM "PostingFind" WHERE "id" = 'f'`)).toEqual({ searchId: "old" });
    } finally {
      db.close();
    }
  });

  it("give every JSON column a default that is JSON", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrate(db, "");
      const tables = db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`).all() as { name: string }[];
      const defaults = tables.flatMap(({ name }) =>
        (db.prepare(`SELECT "name", "type", "dflt_value" FROM pragma_table_info(?)`).all(name) as { name: string; type: string; dflt_value: string | null }[])
          .filter((column) => column.type === "JSONB" && column.dflt_value !== null)
          .map((column) => ({ column: `${name}.${column.name}`, sql: column.dflt_value! })),
      );
      expect(defaults.length).toBeGreaterThan(0);
      for (const { column, sql } of defaults) {
        // A quoted string literal whose text is JSON: `DEFAULT []` without quotes would be stored as ''.
        expect(sql, column).toMatch(/^'[\s\S]*'$/);
        expect(() => JSON.parse(sql.slice(1, -1).replaceAll("''", "'")), column).not.toThrow();
      }
    } finally {
      db.close();
    }
  });
});
