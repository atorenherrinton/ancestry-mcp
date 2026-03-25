#!/usr/bin/env node

/**
 * Finds duplicate ancestors (same name + birth_date, different xrefs)
 * and reports which records have relationships attached.
 *
 * Usage:
 *   node scripts/find-duplicates.js [--merge]
 *
 *   --merge  Automatically merge duplicates: keep the most complete record,
 *            reassign relationships, and delete the spare.
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function supabaseGet(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, { headers });
  if (!res.ok) throw new Error(`GET ${endpoint} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function supabasePatch(table, match, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${match}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function supabaseDelete(table, match) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${match}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`DELETE ${table} failed (${res.status}): ${await res.text()}`);
}

function completenessScore(person) {
  let score = 0;
  if (person.given_name) score++;
  if (person.surname) score++;
  if (person.birth_place) score++;
  if (person.death_date) score++;
  if (person.death_place) score++;
  if (person.burial_place) score++;
  return score;
}

async function findDuplicates() {
  // Fetch all ancestors
  const ancestors = await supabaseGet("ancestors?select=id,gedcom_xref,name,given_name,surname,sex,birth_date,birth_place,death_date,death_place,burial_place&order=name");

  // Group by (name, birth_date) to find duplicates
  const groups = new Map();
  for (const a of ancestors) {
    const key = `${(a.name || "").toLowerCase()}|${a.birth_date || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  return [...groups.values()].filter((g) => g.length > 1);
}

async function getRelationshipCounts(id) {
  const parentOf = await supabaseGet(`ancestor_relationships?parent_id=eq.${id}&select=child_id`);
  const childOf = await supabaseGet(`ancestor_relationships?child_id=eq.${id}&select=parent_id`);
  return { parentOf: parentOf.length, childOf: childOf.length };
}

async function mergeDuplicate(keep, remove) {
  // Get relationships from the record being removed
  const removeParentOf = await supabaseGet(`ancestor_relationships?parent_id=eq.${remove.id}&select=child_id`);
  const removeChildOf = await supabaseGet(`ancestor_relationships?child_id=eq.${remove.id}&select=parent_id`);
  const keepParentOf = await supabaseGet(`ancestor_relationships?parent_id=eq.${keep.id}&select=child_id`);
  const keepChildOf = await supabaseGet(`ancestor_relationships?child_id=eq.${keep.id}&select=parent_id`);

  const keepParentSet = new Set(keepParentOf.map((r) => r.child_id));
  const keepChildSet = new Set(keepChildOf.map((r) => r.parent_id));

  // Reassign parent-of relationships (where remove is parent)
  for (const rel of removeParentOf) {
    if (!keepParentSet.has(rel.child_id)) {
      await supabasePatch(
        "ancestor_relationships",
        `parent_id=eq.${remove.id}&child_id=eq.${rel.child_id}`,
        { parent_id: keep.id }
      );
    }
  }

  // Reassign child-of relationships (where remove is child)
  for (const rel of removeChildOf) {
    if (!keepChildSet.has(rel.parent_id)) {
      await supabasePatch(
        "ancestor_relationships",
        `child_id=eq.${remove.id}&parent_id=eq.${rel.parent_id}`,
        { child_id: keep.id }
      );
    }
  }

  // Reassign any notes
  await supabasePatch(
    "ancestor_notes",
    `ancestor_id=eq.${remove.id}`,
    { ancestor_id: keep.id }
  ).catch(() => {}); // Ignore if no notes to update

  // Delete leftover relationships for the removed record
  await supabaseDelete("ancestor_relationships", `parent_id=eq.${remove.id}`).catch(() => {});
  await supabaseDelete("ancestor_relationships", `child_id=eq.${remove.id}`).catch(() => {});

  // Delete the duplicate ancestor
  await supabaseDelete("ancestors", `id=eq.${remove.id}`);

  console.log(`  Merged: kept ${keep.gedcom_xref} (${keep.id}), deleted ${remove.gedcom_xref} (${remove.id})`);
}

async function main() {
  const doMerge = process.argv.includes("--merge");

  console.log("Searching for duplicate ancestors...\n");
  const duplicateGroups = await findDuplicates();

  if (!duplicateGroups.length) {
    console.log("No duplicates found!");
    return;
  }

  let totalPairs = 0;
  for (const group of duplicateGroups) {
    totalPairs += group.length - 1;
  }
  console.log(`Found ${totalPairs} duplicate pair(s) across ${duplicateGroups.length} group(s):\n`);

  for (const group of duplicateGroups) {
    const first = group[0];
    console.log(`"${first.name}" (born: ${first.birth_date || "unknown"})`);

    const scored = [];
    for (const person of group) {
      const rels = await getRelationshipCounts(person.id);
      const score = completenessScore(person);
      scored.push({ person, score, rels });
      console.log(`  xref=${person.gedcom_xref}  completeness=${score}  parent_of=${rels.parentOf}  child_of=${rels.childOf}  birth_place=${person.birth_place || "(none)"}`);
    }

    if (doMerge) {
      // Sort: highest completeness first, then most relationships
      scored.sort((a, b) => {
        const totalA = a.score * 10 + a.rels.parentOf + a.rels.childOf;
        const totalB = b.score * 10 + b.rels.parentOf + b.rels.childOf;
        return totalB - totalA;
      });

      const keep = scored[0].person;
      for (let i = 1; i < scored.length; i++) {
        await mergeDuplicate(keep, scored[i].person);
      }
    } else {
      scored.sort((a, b) => {
        const totalA = a.score * 10 + a.rels.parentOf + a.rels.childOf;
        const totalB = b.score * 10 + b.rels.parentOf + b.rels.childOf;
        return totalB - totalA;
      });
      console.log(`  → Would keep: ${scored[0].person.gedcom_xref} (most complete)`);
    }
    console.log();
  }

  if (!doMerge) {
    console.log("Run with --merge to automatically merge duplicates.");
  } else {
    console.log("All duplicates merged.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
