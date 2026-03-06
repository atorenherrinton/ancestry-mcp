#!/usr/bin/env node

/**
 * Parses a GEDCOM file and imports persons + parent-child relationships
 * into the ancestors / ancestor_relationships tables.
 *
 * Usage:
 *   node scripts/import-ged-ancestors.js --file /path/to/tree.ged [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parseGedcom(text) {
  const lines = text.split(/\r?\n/);
  const individuals = new Map();
  const families = new Map();

  let currentType = null;
  let currentXref = null;
  let subTag = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    const level = parseInt(line[0], 10);

    if (level === 0) {
      subTag = null;
      const indiMatch = line.match(/^0\s+@([^@]+)@\s+INDI/);
      const famMatch = line.match(/^0\s+@([^@]+)@\s+FAM/);

      if (indiMatch) {
        currentType = "INDI";
        currentXref = indiMatch[1];
        individuals.set(currentXref, {
          xref: currentXref,
          name: null,
          givenName: null,
          surname: null,
          sex: null,
          birthDate: null,
          birthPlace: null,
          deathDate: null,
          deathPlace: null,
          burialPlace: null,
        });
      } else if (famMatch) {
        currentType = "FAM";
        currentXref = famMatch[1];
        families.set(currentXref, { husb: null, wife: null, children: [] });
      } else {
        currentType = null;
        currentXref = null;
      }
      continue;
    }

    if (!currentXref) continue;

    if (currentType === "INDI") {
      const person = individuals.get(currentXref);

      if (level === 1) {
        const tag1 = line.match(/^1\s+(\S+)\s*(.*)/);
        if (!tag1) {
          subTag = null;
          continue;
        }
        const [, tag, value] = tag1;
        subTag = tag;

        switch (tag) {
          case "NAME":
            person.name = value.replace(/\//g, "").trim();
            break;
          case "SEX":
            person.sex = value.trim().charAt(0) || null;
            break;
          case "BIRT":
          case "DEAT":
          case "BURI":
            break;
          default:
            subTag = null;
        }
      } else if (level === 2) {
        const tag2 = line.match(/^2\s+(\S+)\s+(.*)/);
        if (!tag2) continue;
        const [, tag, value] = tag2;
        const val = value.trim();

        if (tag === "GIVN") person.givenName = val;
        if (tag === "SURN") person.surname = val;

        if (subTag === "BIRT") {
          if (tag === "DATE") person.birthDate = val;
          if (tag === "PLAC") person.birthPlace = val;
        } else if (subTag === "DEAT") {
          if (tag === "DATE") person.deathDate = val;
          if (tag === "PLAC") person.deathPlace = val;
        } else if (subTag === "BURI") {
          if (tag === "PLAC") person.burialPlace = val;
        }
      }
    }

    if (currentType === "FAM" && level === 1) {
      const fam = families.get(currentXref);
      const tag1 = line.match(/^1\s+(\S+)\s+@([^@]+)@/);
      if (!tag1) continue;
      const [, tag, ref] = tag1;
      if (tag === "HUSB") fam.husb = ref;
      if (tag === "WIFE") fam.wife = ref;
      if (tag === "CHIL") fam.children.push(ref);
    }
  }

  return { individuals, families };
}

async function importToDb(individuals, families, dryRun) {
  if (dryRun) {
    console.log(`Parsed ${individuals.size} persons, ${families.size} families.`);
    const first = individuals.values().next().value;
    if (first) {
      console.log("\nSample person:");
      console.log(JSON.stringify(first, null, 2));
    }
    const firstFam = families.values().next().value;
    if (firstFam) {
      console.log("\nSample family:");
      console.log(JSON.stringify(firstFam, null, 2));
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const xrefToUuid = new Map();
    let personCount = 0;

    for (const p of individuals.values()) {
      const displayName = p.name || p.givenName || "Unknown";
      const { rows } = await client.query(
        `INSERT INTO ancestors (gedcom_xref, name, given_name, surname, sex,
                                birth_date, birth_place, death_date, death_place, burial_place)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (gedcom_xref) DO UPDATE SET
           name = EXCLUDED.name,
           given_name = EXCLUDED.given_name,
           surname = EXCLUDED.surname,
           sex = EXCLUDED.sex,
           birth_date = EXCLUDED.birth_date,
           birth_place = EXCLUDED.birth_place,
           death_date = EXCLUDED.death_date,
           death_place = EXCLUDED.death_place,
           burial_place = EXCLUDED.burial_place
         RETURNING id`,
        [
          p.xref,
          displayName,
          p.givenName,
          p.surname,
          p.sex,
          p.birthDate,
          p.birthPlace,
          p.deathDate,
          p.deathPlace,
          p.burialPlace,
        ]
      );
      xrefToUuid.set(p.xref, rows[0].id);
      personCount += 1;
    }

    console.log(`Inserted/updated ${personCount} persons.`);

    let relCount = 0;
    for (const fam of families.values()) {
      const parentXrefs = [fam.husb, fam.wife].filter(Boolean);
      for (const childXref of fam.children) {
        const childId = xrefToUuid.get(childXref);
        if (!childId) continue;
        for (const parentXref of parentXrefs) {
          const parentId = xrefToUuid.get(parentXref);
          if (!parentId) continue;
          await client.query(
            `INSERT INTO ancestor_relationships (parent_id, child_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [parentId, childId]
          );
          relCount += 1;
        }
      }
    }

    console.log(`Inserted ${relCount} parent-child relationships.`);

    await client.query("COMMIT");
    console.log("Import complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--file" || args[i] === "-f") {
      filePath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: node scripts/import-ged-ancestors.js --file <path.ged> [--dry-run]");
      return;
    }
    if (!args[i].startsWith("-") && !filePath) filePath = args[i];
  }

  if (!filePath) {
    console.error("Missing --file argument.");
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const text = fs.readFileSync(resolved, "utf8");
  const { individuals, families } = parseGedcom(text);

  await importToDb(individuals, families, dryRun);
  await pool.end();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
