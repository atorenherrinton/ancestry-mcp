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

const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_KEY === "your-secret-key") {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY (service role key) in .env");
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function supabasePost(table, body, onConflict) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (onConflict) url += `?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /${table} failed (${res.status}): ${text}`);
  }
  return res.json();
}

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

  const xrefToUuid = new Map();
  let personCount = 0;

  // Batch persons into chunks for efficiency
  const personArray = [...individuals.values()];
  const BATCH_SIZE = 50;
  for (let i = 0; i < personArray.length; i += BATCH_SIZE) {
    const batch = personArray.slice(i, i + BATCH_SIZE).map((p) => ({
      gedcom_xref: p.xref,
      name: p.name || p.givenName || "Unknown",
      given_name: p.givenName,
      surname: p.surname,
      sex: p.sex,
      birth_date: p.birthDate,
      birth_place: p.birthPlace,
      death_date: p.deathDate,
      death_place: p.deathPlace,
      burial_place: p.burialPlace,
    }));
    const rows = await supabasePost("ancestors", batch, "gedcom_xref");
    for (const row of rows) {
      xrefToUuid.set(row.gedcom_xref, row.id);
    }
    personCount += rows.length;
  }

  console.log(`Inserted/updated ${personCount} persons.`);

  let relCount = 0;
  const relSeen = new Set();
  const relBatch = [];
  for (const fam of families.values()) {
    const parentXrefs = [fam.husb, fam.wife].filter(Boolean);
    for (const childXref of fam.children) {
      const childId = xrefToUuid.get(childXref);
      if (!childId) continue;
      for (const parentXref of parentXrefs) {
        const parentId = xrefToUuid.get(parentXref);
        if (!parentId) continue;
        const key = `${parentId}:${childId}`;
        if (relSeen.has(key)) continue;
        relSeen.add(key);
        relBatch.push({ parent_id: parentId, child_id: childId });
      }
    }
  }

  for (let i = 0; i < relBatch.length; i += BATCH_SIZE) {
    const batch = relBatch.slice(i, i + BATCH_SIZE);
    await supabasePost("ancestor_relationships", batch, "parent_id,child_id");
    relCount += batch.length;
  }

  console.log(`Inserted ${relCount} parent-child relationships.`);
  console.log("Import complete.");
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
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
