const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const pgvector = require("pgvector");
const { createPool } = require("./lib/db");

const envPath = path.resolve(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_NOTE_CHARS = 12000;

const pool = createPool();

// ─── AI Helpers ───────────────────────────────────────────
async function getEmbedding(text) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractNoteMetadata(text) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from a personal note about a family ancestor. Return JSON with:
- "people": array of people mentioned (empty if none)
- "topics": array of 1-3 short topic tags (always at least one, e.g. "immigration", "military", "occupation", "marriage", "religion")
- "type": one of "story", "research_note", "source_reference", "question", "observation"
- "time_period": approximate era if mentioned (e.g. "1800s", "Civil War", "colonial") or null
- "locations": array of places mentioned (empty if none)
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

let transportMode = "unknown";

function send(msg) {
  const payload = JSON.stringify(msg);

  if (transportMode === "line") {
    process.stdout.write(payload + "\n");
    return;
  }

  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header + payload);
}

const TOOLS = [
  {
    name: "ancestor_stats",
    description:
      "Get a high-level summary of your entire family tree: total ancestors, countries/regions of origin (with counts), top surnames, earliest and latest birth years, and male/female breakdown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_ancestors",
    description:
      "Search the family tree by any combination of name, given name, surname, birth date/year range, birth place, death date/year range, death place, burial place, or sex. Optionally trace a person's lineage up the tree.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Full or partial name to search for",
        },
        given_name: {
          type: "string",
          description: "First/given name to search for (e.g. 'Mary', 'Johann')",
        },
        surname: {
          type: "string",
          description: "Family/surname to search for (e.g. 'Smith', 'Mueller')",
        },
        birth_date: {
          type: "string",
          description: "Full or partial birth date to match (e.g. '1820', 'MAR 1820', '15 MAR 1820')",
        },
        birth_year_from: {
          type: "number",
          description: "Find ancestors born in or after this year (e.g. 1800)",
        },
        birth_year_to: {
          type: "number",
          description: "Find ancestors born in or before this year (e.g. 1850)",
        },
        birth_place: {
          type: "string",
          description: "Full or partial birth place to match (e.g. 'Germany', 'California', 'London')",
        },
        death_date: {
          type: "string",
          description: "Full or partial death date to match (e.g. '1890', 'JUN 1890')",
        },
        death_year_from: {
          type: "number",
          description: "Find ancestors who died in or after this year (e.g. 1860)",
        },
        death_year_to: {
          type: "number",
          description: "Find ancestors who died in or before this year (e.g. 1900)",
        },
        death_place: {
          type: "string",
          description: "Full or partial death place to match (e.g. 'New York', 'England')",
        },
        burial_place: {
          type: "string",
          description: "Full or partial burial place to match",
        },
        sex: {
          type: "string",
          description: "Filter by sex: 'M' for male, 'F' for female",
        },
        lineage: {
          type: "boolean",
          description: "If true, trace ancestors upward from the first match",
          default: false,
        },
        generations: {
          type: "number",
          description: "Max generations to trace when lineage is true (default 10)",
          default: 10,
        },
      },
    },
  },
  {
    name: "capture_ancestor_note",
    description:
      "Save a personal note about an ancestor. Automatically generates a semantic embedding and extracts metadata. Optionally link to a specific ancestor by name (will fuzzy-match).",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The note to save — a clear, standalone statement about an ancestor",
        },
        ancestor_name: {
          type: "string",
          description: "Name of the ancestor this note is about (fuzzy matched). Optional.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "search_ancestor_notes",
    description:
      "Search your personal ancestor notes by meaning. Use this when looking for notes about a topic, person, story, or research question you've previously captured.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        ancestor_name: {
          type: "string",
          description: "Optionally limit search to notes about a specific ancestor (fuzzy matched)",
        },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.5)", default: 0.5 },
      },
      required: ["query"],
    },
  },
  {
    name: "list_ancestor_notes",
    description:
      "List personal ancestor notes with optional filters by type, topic, ancestor name, or time range.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 10 },
        type: { type: "string", description: "Filter: story, research_note, source_reference, question, observation" },
        topic: { type: "string", description: "Filter by topic tag" },
        ancestor_name: { type: "string", description: "Filter by ancestor name (fuzzy matched)" },
        days: { type: "number", description: "Only notes from the last N days" },
      },
    },
  },
];

// ─── Helper: resolve ancestor by fuzzy name ───────────────
async function resolveAncestorId(name) {
  if (!name) return null;
  const { rows } = await pool.query(
    `SELECT id, name FROM ancestors WHERE name ILIKE $1 ORDER BY name LIMIT 1`,
    [`%${name}%`]
  );
  return rows.length ? rows[0] : null;
}

async function handleAncestorStats() {
  const { rows: countRows } = await pool.query("SELECT count(*) FROM ancestors");
  const total = parseInt(countRows[0].count, 10);
  if (!total) return "No ancestors in the family tree yet.";

  const { rows } = await pool.query(
    "SELECT name, surname, sex, birth_date, birth_place, death_date, death_place, burial_place FROM ancestors"
  );

  function extractCountry(place) {
    if (!place) return null;
    const parts = place
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }

  function extractYear(dateStr) {
    if (!dateStr) return null;
    const m = dateStr.match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  const countries = {};
  const surnames = {};
  const sexes = { M: 0, F: 0, unknown: 0 };
  let earliestBirth = Infinity;
  let latestBirth = -Infinity;
  let earliestDeath = Infinity;
  let latestDeath = -Infinity;

  for (const a of rows) {
    const personCountries = new Set();
    for (const place of [a.birth_place, a.death_place, a.burial_place]) {
      const c = extractCountry(place);
      if (c) personCountries.add(c);
    }
    for (const c of personCountries) countries[c] = (countries[c] || 0) + 1;

    if (a.surname) surnames[a.surname] = (surnames[a.surname] || 0) + 1;

    if (a.sex === "M" || a.sex === "F") sexes[a.sex] += 1;
    else sexes.unknown += 1;

    const by = extractYear(a.birth_date);
    if (by) {
      earliestBirth = Math.min(earliestBirth, by);
      latestBirth = Math.max(latestBirth, by);
    }
    const dy = extractYear(a.death_date);
    if (dy) {
      earliestDeath = Math.min(earliestDeath, dy);
      latestDeath = Math.max(latestDeath, dy);
    }
  }

  const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

  const lines = [
    `Total ancestors: ${total}`,
    `Male: ${sexes.M}  |  Female: ${sexes.F}${sexes.unknown ? `  |  Unknown: ${sexes.unknown}` : ""}`,
  ];

  if (earliestBirth !== Infinity) {
    lines.push(`Birth year range: ${earliestBirth} - ${latestBirth === -Infinity ? "?" : latestBirth}`);
  }
  if (earliestDeath !== Infinity) {
    lines.push(`Death year range: ${earliestDeath} - ${latestDeath === -Infinity ? "?" : latestDeath}`);
  }

  const sortedCountries = sort(countries);
  if (sortedCountries.length) {
    lines.push("", `Countries / Regions (${sortedCountries.length}):`);
    for (const [k, v] of sortedCountries) lines.push(`  ${k}: ${v}`);
  }

  const sortedSurnames = sort(surnames).slice(0, 20);
  if (sortedSurnames.length) {
    lines.push("", "Top surnames:");
    for (const [k, v] of sortedSurnames) lines.push(`  ${k}: ${v}`);
  }

  return lines.join("\n");
}

async function handleFindAncestors({
  name,
  given_name,
  surname,
  birth_date,
  birth_year_from,
  birth_year_to,
  birth_place,
  death_date,
  death_year_from,
  death_year_to,
  death_place,
  burial_place,
  sex,
  lineage = false,
  generations = 10,
}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (name) {
    conditions.push(`name ILIKE $${idx++}`);
    params.push(`%${name}%`);
  }
  if (given_name) {
    conditions.push(`given_name ILIKE $${idx++}`);
    params.push(`%${given_name}%`);
  }
  if (surname) {
    conditions.push(`surname ILIKE $${idx++}`);
    params.push(`%${surname}%`);
  }
  if (birth_date) {
    conditions.push(`birth_date ILIKE $${idx++}`);
    params.push(`%${birth_date}%`);
  }
  if (birth_year_from) {
    conditions.push(`CAST(substring(birth_date FROM '[0-9]{4}') AS INTEGER) >= $${idx++}`);
    params.push(birth_year_from);
  }
  if (birth_year_to) {
    conditions.push(`CAST(substring(birth_date FROM '[0-9]{4}') AS INTEGER) <= $${idx++}`);
    params.push(birth_year_to);
  }
  if (birth_place) {
    conditions.push(`birth_place ILIKE $${idx++}`);
    params.push(`%${birth_place}%`);
  }
  if (death_date) {
    conditions.push(`death_date ILIKE $${idx++}`);
    params.push(`%${death_date}%`);
  }
  if (death_year_from) {
    conditions.push(`CAST(substring(death_date FROM '[0-9]{4}') AS INTEGER) >= $${idx++}`);
    params.push(death_year_from);
  }
  if (death_year_to) {
    conditions.push(`CAST(substring(death_date FROM '[0-9]{4}') AS INTEGER) <= $${idx++}`);
    params.push(death_year_to);
  }
  if (death_place) {
    conditions.push(`death_place ILIKE $${idx++}`);
    params.push(`%${death_place}%`);
  }
  if (burial_place) {
    conditions.push(`burial_place ILIKE $${idx++}`);
    params.push(`%${burial_place}%`);
  }
  if (sex) {
    conditions.push(`sex = $${idx++}`);
    params.push(sex.charAt(0).toUpperCase());
  }

  if (!conditions.length) {
    return "Please provide at least one search filter (name, given_name, surname, birth_date, birth_year_from/to, birth_place, death_date, death_year_from/to, death_place, burial_place, or sex).";
  }

  const sql = `SELECT * FROM ancestors WHERE ${conditions.join(" AND ")} ORDER BY surname, given_name LIMIT 20`;
  const { rows } = await pool.query(sql, params);

  const filterDesc = [
    name,
    given_name,
    surname,
    birth_date,
    birth_year_from,
    birth_year_to,
    birth_place,
    death_date,
    death_year_from,
    death_year_to,
    death_place,
    burial_place,
    sex,
  ]
    .filter(Boolean)
    .join(", ");
  if (!rows.length) return `No ancestors found matching "${filterDesc}".`;

  if (!lineage) {
    return rows.map((a) => formatAncestor(a)).join("\n\n");
  }

  const person = rows[0];
  const { rows: tree } = await pool.query(`SELECT * FROM trace_lineage($1, $2)`, [
    person.id,
    generations,
  ]);

  const genLabels = [
    "Self",
    "Parents",
    "Grandparents",
    "Great-grandparents",
    "2x Great-grandparents",
    "3x Great-grandparents",
  ];

  const grouped = new Map();
  for (const row of tree) {
    if (!grouped.has(row.generation)) grouped.set(row.generation, []);
    grouped.get(row.generation).push(row);
  }

  const lines = [];
  for (const [gen, members] of grouped) {
    const label = gen < genLabels.length ? genLabels[gen] : `${gen - 2}x Great-grandparents`;
    lines.push(`-- Generation ${gen} (${label}) --`);
    for (const m of members) lines.push(formatAncestor(m));
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Ancestor Notes Handlers ──────────────────────────────

async function handleCaptureAncestorNote({ content, ancestor_name }) {
  const normalizedContent = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[\t ]+/gm, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalizedContent) {
    throw new Error("Note content cannot be empty.");
  }

  if (normalizedContent.length > MAX_NOTE_CHARS) {
    throw new Error(
      `Note is too long (${normalizedContent.length} chars). Max allowed is ${MAX_NOTE_CHARS}.`
    );
  }

  const ancestor = await resolveAncestorId(ancestor_name);

  const [embedding, metadata] = await Promise.all([
    getEmbedding(normalizedContent),
    extractNoteMetadata(normalizedContent),
  ]);

  await pool.query(
    `INSERT INTO ancestor_notes (ancestor_id, content, embedding, metadata) VALUES ($1, $2, $3, $4)`,
    [ancestor ? ancestor.id : null, normalizedContent, pgvector.toSql(embedding), { ...metadata, source: "mcp" }]
  );

  let confirmation = `Saved as ${metadata.type || "note"}`;
  if (ancestor) confirmation += ` for ${ancestor.name}`;
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  if (metadata.locations?.length) confirmation += ` | Places: ${metadata.locations.join(", ")}`;
  if (metadata.time_period) confirmation += ` | Era: ${metadata.time_period}`;
  return confirmation;
}

async function handleSearchAncestorNotes({ query, ancestor_name, limit = 10, threshold = 0.5 }) {
  const qEmb = await getEmbedding(query);
  const ancestor = await resolveAncestorId(ancestor_name);

  const { rows } = await pool.query(
    `SELECT * FROM match_ancestor_notes($1, $2, $3, $4, $5)`,
    [pgvector.toSql(qEmb), threshold, limit, "{}", ancestor ? ancestor.id : null]
  );
  if (!rows.length) return `No ancestor notes found matching "${query}".`;

  return rows
    .map((n, i) => {
      const m = n.metadata || {};
      const parts = [
        `--- Result ${i + 1} (${(n.similarity * 100).toFixed(1)}% match) ---`,
        `Captured: ${new Date(n.created_at).toLocaleDateString()}`,
        `Type: ${m.type || "unknown"}`,
      ];
      if (n.ancestor_name) parts.push(`Ancestor: ${n.ancestor_name}`);
      if (m.topics?.length) parts.push(`Topics: ${m.topics.join(", ")}`);
      if (m.locations?.length) parts.push(`Places: ${m.locations.join(", ")}`);
      if (m.time_period) parts.push(`Era: ${m.time_period}`);
      if (m.people?.length) parts.push(`People: ${m.people.join(", ")}`);
      parts.push(`\n${n.content}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

async function handleListAncestorNotes({ limit = 10, type, topic, ancestor_name, days }) {
  let sql = `SELECT n.id, n.content, n.metadata, n.created_at, a.name AS ancestor_name
    FROM ancestor_notes n LEFT JOIN ancestors a ON a.id = n.ancestor_id`;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (type) {
    conditions.push(`n.metadata->>'type' = $${idx++}`);
    params.push(type);
  }
  if (topic) {
    conditions.push(`n.metadata->'topics' ? $${idx++}`);
    params.push(topic);
  }
  if (ancestor_name) {
    conditions.push(`a.name ILIKE $${idx++}`);
    params.push(`%${ancestor_name}%`);
  }
  if (days) {
    conditions.push(`n.created_at >= now() - interval '${parseInt(days)} days'`);
  }

  if (conditions.length) sql += ` WHERE ` + conditions.join(" AND ");
  sql += ` ORDER BY n.created_at DESC LIMIT $${idx}`;
  params.push(parseInt(limit));

  const { rows } = await pool.query(sql, params);
  if (!rows.length) return "No ancestor notes found.";

  return rows
    .map((n, i) => {
      const m = n.metadata || {};
      const tags = m.topics?.length ? m.topics.join(", ") : "";
      const who = n.ancestor_name ? ` [${n.ancestor_name}]` : "";
      return `${i + 1}. [${new Date(n.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " — " + tags : ""})${who}\n   ${n.content}`;
    })
    .join("\n\n");
}

function formatAncestor(a) {
  const parts = [`${a.name}`];
  if (a.sex) parts[0] += ` (${a.sex === "M" ? "Male" : a.sex === "F" ? "Female" : a.sex})`;
  if (a.birth_date || a.birth_place) {
    parts.push(`  Born: ${[a.birth_date, a.birth_place].filter(Boolean).join(", ")}`);
  }
  if (a.death_date || a.death_place) {
    parts.push(`  Died: ${[a.death_date, a.death_place].filter(Boolean).join(", ")}`);
  }
  if (a.burial_place) {
    parts.push(`  Buried: ${a.burial_place}`);
  }
  return parts.join("\n");
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

function processRawMessage(raw, source = "unknown") {
  const trimmed = raw.trim();
  if (!trimmed) return;

  if (transportMode === "unknown") {
    if (source === "line") transportMode = "line";
    if (source === "framed") transportMode = "framed";
  }

  try {
    handleMessage(JSON.parse(trimmed));
  } catch (e) {
    console.error("Parse error:", e);
  }
}

function processBuffer() {
  while (inputBuffer.length > 0) {
    const headerEndCrlf = inputBuffer.indexOf("\r\n\r\n");
    const headerEndLf = inputBuffer.indexOf("\n\n");

    let headerEnd = -1;
    let delimiterLength = 0;

    if (headerEndCrlf !== -1 && (headerEndLf === -1 || headerEndCrlf < headerEndLf)) {
      headerEnd = headerEndCrlf;
      delimiterLength = 4;
    } else if (headerEndLf !== -1) {
      headerEnd = headerEndLf;
      delimiterLength = 2;
    }

    if (headerEnd === -1) {
      const newline = inputBuffer.indexOf("\n");
      if (newline === -1) break;

      const line = inputBuffer.slice(0, newline).toString("utf8");
      inputBuffer = inputBuffer.slice(newline + 1);
      processRawMessage(line, "line");
      continue;
    }

    const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = headerText.match(/content-length\s*:\s*(\d+)/i);

    if (!match) {
      const maybeJson = inputBuffer.slice(0, headerEnd).toString("utf8");
      inputBuffer = inputBuffer.slice(headerEnd + delimiterLength);
      processRawMessage(maybeJson, "line");
      continue;
    }

    if (transportMode === "unknown") {
      transportMode = "framed";
    }

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + delimiterLength;
    const messageEnd = messageStart + contentLength;

    if (inputBuffer.length < messageEnd) break;

    const payload = inputBuffer.slice(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEnd);
    processRawMessage(payload, "framed");
  }
}

async function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ancestry-mcp", version: "1.0.0" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    return;
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS },
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params || {};
    try {
      let result;
      switch (name) {
        case "ancestor_stats":
          result = await handleAncestorStats();
          break;
        case "find_ancestors":
          result = await handleFindAncestors(args);
          break;
        case "capture_ancestor_note":
          result = await handleCaptureAncestorNote(args);
          break;
        case "search_ancestor_notes":
          result = await handleSearchAncestorNotes(args);
          break;
        case "list_ancestor_notes":
          result = await handleListAncestorNotes(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: result }] },
      });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      });
    }
  } else if (msg.id) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
