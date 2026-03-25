import { createClient } from "npm:@supabase/supabase-js@2";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "npm:zod@3.24.1";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_NOTE_CHARS = 12000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ancestry-key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function requireSupabaseServiceRoleKey() {
  return Deno.env.get("SUPABASE_SECRET_KEY") || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

// ─── OAuth 2.0 Client Credentials ───────────────────────────────────

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return base64url(String.fromCharCode(...sig));
}

async function createJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const expected = await hmacSign(secret, `${h}.${p}`);
  if (expected !== s) return null;
  try {
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBaseUrl(url: URL, functionName: string): string {
  const path = url.pathname;
  const idx = path.lastIndexOf(`/${functionName}`);
  return idx === -1 ? url.origin : url.origin + path.substring(0, idx + functionName.length + 1);
}

function oauthMetadata(baseUrl: string): Response {
  return jsonResponse({
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["client_credentials"],
    response_types_supported: [],
    code_challenge_methods_supported: [],
  });
}

function protectedResourceMetadata(baseUrl: string): Response {
  return jsonResponse({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  });
}

async function handleOAuthToken(req: Request): Promise<Response> {
  const clientId = Deno.env.get("OAUTH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("OAUTH_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "oauth_not_configured" }, 500);
  }

  let grantType = "", reqId = "", reqSecret = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await req.text());
    grantType = params.get("grant_type") ?? "";
    reqId = params.get("client_id") ?? "";
    reqSecret = params.get("client_secret") ?? "";
  } else {
    const body = await req.json();
    grantType = body.grant_type ?? "";
    reqId = body.client_id ?? "";
    reqSecret = body.client_secret ?? "";
  }

  if (grantType !== "client_credentials") {
    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }
  if (reqId !== clientId || reqSecret !== clientSecret) {
    return jsonResponse({ error: "invalid_client" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600;
  const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || clientSecret;
  const token = await createJWT({ sub: clientId, iat: now, exp: now + expiresIn }, jwtSecret);

  return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

async function requireAuth(req: Request) {
  // Check for OAuth Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || Deno.env.get("OAUTH_CLIENT_SECRET") || "";
    if (jwtSecret) {
      const payload = await verifyJWT(authHeader.slice(7), jwtSecret);
      if (payload) return;
    }
    throw new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fall back to static key
  const expected = Deno.env.get("ANCESTRY_ACCESS_KEY") ?? "";
  if (!expected) return;

  const url = new URL(req.url);
  const key = req.headers.get("x-ancestry-key") || url.searchParams.get("key");
  if (key !== expected) {
    throw new Response(JSON.stringify({ error: "Invalid or missing access key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function getAction(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("ancestry");
  if (functionIndex === -1) {
    return url.searchParams.get("action") || "";
  }
  return parts.slice(functionIndex + 1).join("/") || url.searchParams.get("action") || "";
}

function requireOpenRouterApiKey() {
  return requireEnv("OPENROUTER_API_KEY");
}

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenRouterApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });

  if (!res.ok) {
    throw new Error(`Embedding failed: ${res.status}`);
  }

  const data = await res.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response missing vector data");
  }

  return embedding as number[];
}

async function extractNoteMetadata(text: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenRouterApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract metadata from a personal note about a family ancestor. Return JSON with:\n" +
            '- "people": array of people mentioned (empty if none)\n' +
            '- "topics": array of 1-3 short topic tags (always at least one, e.g. "immigration", "military", "occupation", "marriage", "religion")\n' +
            '- "type": one of "story", "research_note", "source_reference", "question", "observation"\n' +
            '- "time_period": approximate era if mentioned (e.g. "1800s", "Civil War", "colonial") or null\n' +
            '- "locations": array of places mentioned (empty if none)\n' +
            "Only extract what's explicitly there.",
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Metadata extraction failed: ${res.status}`);
  }

  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

async function resolveAncestorByName(
  supabase: ReturnType<typeof createClient>,
  name: string | undefined
) {
  if (!name) {
    return null;
  }

  const { data, error } = await supabase
    .from("ancestors")
    .select("id, name")
    .ilike("name", `%${name}%`)
    .order("name", { ascending: true })
    .limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

function normalizeNoteContent(content: unknown) {
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[\t ]+/gm, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");
}

async function captureAncestorNote(
  supabase: ReturnType<typeof createClient>,
  args: Record<string, unknown>
) {
  const content = normalizeNoteContent(args.content);
  if (!content) {
    throw new Error("Note content cannot be empty.");
  }

  if (content.length > MAX_NOTE_CHARS) {
    throw new Error(`Note is too long (${content.length} chars). Max allowed is ${MAX_NOTE_CHARS}.`);
  }

  const ancestor = await resolveAncestorByName(
    supabase,
    typeof args.ancestor_name === "string" ? args.ancestor_name : undefined
  );

  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractNoteMetadata(content),
  ]);

  const metadataWithSource = {
    ...(metadata ?? {}),
    source: "mcp",
  };

  const { error } = await supabase.from("ancestor_notes").insert({
    ancestor_id: ancestor?.id ?? null,
    content,
    embedding: toVectorLiteral(embedding),
    metadata: metadataWithSource,
  });

  if (error) {
    throw error;
  }

  const topics = Array.isArray((metadataWithSource as Record<string, unknown>).topics)
    ? ((metadataWithSource as Record<string, unknown>).topics as string[])
    : [];
  const locations = Array.isArray((metadataWithSource as Record<string, unknown>).locations)
    ? ((metadataWithSource as Record<string, unknown>).locations as string[])
    : [];
  const type =
    typeof (metadataWithSource as Record<string, unknown>).type === "string"
      ? ((metadataWithSource as Record<string, unknown>).type as string)
      : "note";
  const timePeriod =
    typeof (metadataWithSource as Record<string, unknown>).time_period === "string"
      ? ((metadataWithSource as Record<string, unknown>).time_period as string)
      : null;

  let confirmation = `Saved as ${type}`;
  if (ancestor?.name) {
    confirmation += ` for ${ancestor.name}`;
  }
  if (topics.length) {
    confirmation += ` - ${topics.join(", ")}`;
  }
  if (locations.length) {
    confirmation += ` | Places: ${locations.join(", ")}`;
  }
  if (timePeriod) {
    confirmation += ` | Era: ${timePeriod}`;
  }

  return { message: confirmation };
}

async function searchAncestorNotes(
  supabase: ReturnType<typeof createClient>,
  args: Record<string, unknown>
) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("query is required");
  }

  const limit = Number(args.limit ?? 10);
  const threshold = Number(args.threshold ?? 0.5);
  const ancestor = await resolveAncestorByName(
    supabase,
    typeof args.ancestor_name === "string" ? args.ancestor_name : undefined
  );

  const queryEmbedding = await getEmbedding(query);
  const { data, error } = await supabase.rpc("match_ancestor_notes", {
    query_embedding: toVectorLiteral(queryEmbedding),
    match_threshold: threshold,
    match_count: limit,
    filter: {},
    p_ancestor_id: ancestor?.id ?? null,
  });

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  if (!rows.length) {
    return { message: `No ancestor notes found matching "${query}".` };
  }

  const lines: string[] = [];
  rows.forEach((note: Record<string, unknown>, index: number) => {
    const metadata = (note.metadata ?? {}) as Record<string, unknown>;
    const similarity =
      typeof note.similarity === "number" ? `${(note.similarity * 100).toFixed(1)}%` : "n/a";

    lines.push(`--- Result ${index + 1} (${similarity} match) ---`);
    if (note.created_at) {
      lines.push(`Captured: ${new Date(String(note.created_at)).toLocaleDateString()}`);
    }
    lines.push(`Type: ${String(metadata.type ?? "unknown")}`);
    if (note.ancestor_name) {
      lines.push(`Ancestor: ${String(note.ancestor_name)}`);
    }
    if (Array.isArray(metadata.topics) && metadata.topics.length) {
      lines.push(`Topics: ${(metadata.topics as unknown[]).map(String).join(", ")}`);
    }
    if (Array.isArray(metadata.locations) && metadata.locations.length) {
      lines.push(`Places: ${(metadata.locations as unknown[]).map(String).join(", ")}`);
    }
    if (metadata.time_period) {
      lines.push(`Era: ${String(metadata.time_period)}`);
    }
    if (Array.isArray(metadata.people) && metadata.people.length) {
      lines.push(`People: ${(metadata.people as unknown[]).map(String).join(", ")}`);
    }
    lines.push("", String(note.content ?? ""));
    lines.push("");
  });

  return { message: lines.join("\n").trim() };
}

async function listAncestorNotes(
  supabase: ReturnType<typeof createClient>,
  args: Record<string, unknown>
) {
  const limit = Number(args.limit ?? 10);
  const type = typeof args.type === "string" ? args.type : undefined;
  const topic = typeof args.topic === "string" ? args.topic : undefined;
  const days = Number(args.days);
  const ancestorName = typeof args.ancestor_name === "string" ? args.ancestor_name : undefined;

  let query = supabase
    .from("ancestor_notes")
    .select("id, content, metadata, created_at, ancestors:ancestor_id(name)")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (type) {
    query = query.eq("metadata->>type", type);
  }
  if (topic) {
    query = query.filter("metadata->topics", "cs", JSON.stringify([topic]));
  }
  if (days && Number.isFinite(days) && days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }
  if (ancestorName) {
    query = query.ilike("ancestors.name", `%${ancestorName}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = data ?? [];
  if (!rows.length) {
    return { message: "No ancestor notes found." };
  }

  const lines = rows.map((note: Record<string, unknown>, index: number) => {
    const metadata = (note.metadata ?? {}) as Record<string, unknown>;
    const topics = Array.isArray(metadata.topics)
      ? (metadata.topics as unknown[]).map(String).join(", ")
      : "";
    const ancestor =
      note.ancestors && typeof note.ancestors === "object"
        ? (note.ancestors as Record<string, unknown>).name
        : null;
    const header = `${index + 1}. [${new Date(String(note.created_at)).toLocaleDateString()}] (${String(
      metadata.type ?? "??"
    )}${topics ? ` - ${topics}` : ""})${ancestor ? ` [${String(ancestor)}]` : ""}`;

    return `${header}\n   ${String(note.content ?? "")}`;
  });

  return { message: lines.join("\n\n") };
}

function extractCountry(place: string | null) {
  if (!place) {
    return null;
  }

  const parts = place
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts[parts.length - 1] : null;
}

function extractYear(dateValue: string | null) {
  if (!dateValue) {
    return null;
  }

  const match = dateValue.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

async function buildStats(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("ancestors")
    .select("name, surname, sex, birth_date, birth_place, death_date, death_place, burial_place")
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  const countries = new Map<string, number>();
  const surnames = new Map<string, number>();
  const sexes = { M: 0, F: 0, unknown: 0 };
  let earliestBirth = Number.POSITIVE_INFINITY;
  let latestBirth = Number.NEGATIVE_INFINITY;
  let earliestDeath = Number.POSITIVE_INFINITY;
  let latestDeath = Number.NEGATIVE_INFINITY;

  for (const person of data ?? []) {
    const seenCountries = new Set<string>();
    for (const place of [person.birth_place, person.death_place, person.burial_place]) {
      const country = extractCountry(place);
      if (country) {
        seenCountries.add(country);
      }
    }

    for (const country of seenCountries) {
      countries.set(country, (countries.get(country) ?? 0) + 1);
    }

    if (person.surname) {
      surnames.set(person.surname, (surnames.get(person.surname) ?? 0) + 1);
    }

    if (person.sex === "M" || person.sex === "F") {
      sexes[person.sex] += 1;
    } else {
      sexes.unknown += 1;
    }

    const birthYear = extractYear(person.birth_date);
    if (birthYear) {
      earliestBirth = Math.min(earliestBirth, birthYear);
      latestBirth = Math.max(latestBirth, birthYear);
    }

    const deathYear = extractYear(person.death_date);
    if (deathYear) {
      earliestDeath = Math.min(earliestDeath, deathYear);
      latestDeath = Math.max(latestDeath, deathYear);
    }
  }

  const sortEntries = (entries: Map<string, number>, limit?: number) =>
    [...entries.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

  return {
    total: data?.length ?? 0,
    sex_breakdown: sexes,
    birth_year_range:
      earliestBirth === Number.POSITIVE_INFINITY
        ? null
        : { earliest: earliestBirth, latest: latestBirth },
    death_year_range:
      earliestDeath === Number.POSITIVE_INFINITY
        ? null
        : { earliest: earliestDeath, latest: latestDeath },
    countries: sortEntries(countries),
    top_surnames: sortEntries(surnames, 20),
  };
}

async function searchAncestors(
  supabase: ReturnType<typeof createClient>,
  args: Record<string, unknown>
) {
  const lineage = Boolean(args.lineage);
  const generations = Number(args.generations || 10);

  const { data, error } = await supabase.rpc("search_ancestors", {
    p_name: args.name ?? null,
    p_given_name: args.given_name ?? null,
    p_surname: args.surname ?? null,
    p_birth_date: args.birth_date ?? null,
    p_birth_year_from: args.birth_year_from ?? null,
    p_birth_year_to: args.birth_year_to ?? null,
    p_birth_place: args.birth_place ?? null,
    p_death_date: args.death_date ?? null,
    p_death_year_from: args.death_year_from ?? null,
    p_death_year_to: args.death_year_to ?? null,
    p_death_place: args.death_place ?? null,
    p_burial_place: args.burial_place ?? null,
    p_sex: args.sex ?? null,
    p_limit: args.limit ?? 20,
  });

  if (error) {
    throw error;
  }

  if (!lineage || !data?.length) {
    return { count: data?.length ?? 0, results: data ?? [] };
  }

  const { data: lineageRows, error: lineageError } = await supabase.rpc("trace_lineage", {
    start_id: data[0].id,
    max_generations: generations,
  });

  if (lineageError) {
    throw lineageError;
  }

  return {
    count: data.length,
    results: data,
    lineage: lineageRows ?? [],
  };
}

// ─── Relationship Helpers ─────────────────────────────────

function getRelationshipLabel(genA: number, genB: number, sexOfB: string | null): string {
  if (genA === 0 && genB === 0) return "the same person";

  if (genB === 0) {
    if (genA === 1) return sexOfB === "F" ? "your mother" : "your father";
    if (genA === 2) return sexOfB === "F" ? "your grandmother" : "your grandfather";
    if (genA === 3) return sexOfB === "F" ? "your great-grandmother" : "your great-grandfather";
    const greats = genA - 2;
    const prefix = greats === 1 ? "great" : `${greats}x great`;
    return sexOfB === "F" ? `your ${prefix}-grandmother` : `your ${prefix}-grandfather`;
  }

  if (genA === 0) {
    if (genB === 1) return sexOfB === "F" ? "your daughter" : "your son";
    if (genB === 2) return sexOfB === "F" ? "your granddaughter" : "your grandson";
    const greats = genB - 2;
    const prefix = greats === 1 ? "great" : `${greats}x great`;
    return sexOfB === "F" ? `your ${prefix}-granddaughter` : `your ${prefix}-grandson`;
  }

  if (genA === 1 && genB === 1) {
    return sexOfB === "F" ? "your sister" : sexOfB === "M" ? "your brother" : "your sibling";
  }

  if (genA === 2 && genB === 1) {
    return sexOfB === "F" ? "your aunt" : sexOfB === "M" ? "your uncle" : "your aunt/uncle";
  }

  if (genA === 1 && genB === 2) {
    return sexOfB === "F" ? "your niece" : sexOfB === "M" ? "your nephew" : "your niece/nephew";
  }

  if (genB === 1 && genA > 2) {
    const greats = genA - 2;
    const prefix = greats === 1 ? "great" : `${greats}x great`;
    return sexOfB === "F" ? `your ${prefix}-aunt` : sexOfB === "M" ? `your ${prefix}-uncle` : `your ${prefix}-aunt/uncle`;
  }

  if (genA === 1 && genB > 2) {
    const greats = genB - 2;
    const prefix = greats === 1 ? "great" : `${greats}x great`;
    return sexOfB === "F" ? `your ${prefix}-niece` : sexOfB === "M" ? `your ${prefix}-nephew` : `your ${prefix}-niece/nephew`;
  }

  const cousinDegree = Math.min(genA, genB) - 1;
  const removed = Math.abs(genA - genB);

  const ordinals = ["", "1st", "2nd", "3rd"];
  const ord = cousinDegree < ordinals.length ? ordinals[cousinDegree] : `${cousinDegree}th`;

  let label = `your ${ord} cousin`;
  if (removed === 1) label += " once removed";
  else if (removed === 2) label += " twice removed";
  else if (removed === 3) label += " thrice removed";
  else if (removed > 3) label += ` ${removed}x removed`;

  return label;
}

function describePathSegment(sex: string | null): string {
  return sex === "F" ? "mother" : sex === "M" ? "father" : "parent";
}

async function buildPathDescription(
  supabase: ReturnType<typeof createClient>,
  pathIds: string[]
): Promise<string | null> {
  if (pathIds.length <= 2) return null;

  const intermediateIds = pathIds.slice(1, -1);
  if (!intermediateIds.length) return null;

  const { data, error } = await supabase
    .from("ancestors")
    .select("id, name, sex")
    .in("id", intermediateIds);

  if (error) throw error;

  const byId = new Map((data ?? []).map((r: Record<string, unknown>) => [r.id, r]));
  const parts = intermediateIds.map((id: string) => {
    const person = byId.get(id) as Record<string, unknown> | undefined;
    return person ? describePathSegment(person.sex as string | null) : "parent";
  });

  return "through your " + parts.join("'s ");
}

async function buildLineageTrace(
  supabase: ReturnType<typeof createClient>,
  pathFromA: string[],
  pathFromB: string[]
): Promise<string[]> {
  const allIds = [...new Set([...pathFromA, ...pathFromB])];

  const { data, error } = await supabase
    .from("ancestors")
    .select("id, name, birth_date")
    .in("id", allIds);

  if (error) throw error;

  const byId = new Map((data ?? []).map((r: Record<string, unknown>) => [r.id, r]));

  function personLabel(id: string): string {
    const p = byId.get(id) as Record<string, unknown> | undefined;
    if (!p) return "Unknown";
    const dateStr = p.birth_date ? String(p.birth_date) : "";
    const yearMatch = dateStr.match(/(\d{4})/);
    return yearMatch ? `${p.name} (b. ${yearMatch[1]})` : String(p.name ?? "Unknown");
  }

  const reversedA = [...pathFromA].reverse();

  if (pathFromB.length <= 1) {
    return reversedA.map((id: string) => personLabel(id));
  }

  const targetBranch = pathFromB.map((id: string) => personLabel(id));
  const rootBranch = reversedA.slice(1).map((id: string) => personLabel(id));

  return [...targetBranch, ...rootBranch];
}

async function findRelationship(
  supabase: ReturnType<typeof createClient>,
  args: Record<string, unknown>
) {
  const rootXref = Deno.env.get("ROOT_PERSON_XREF");
  if (!rootXref) {
    return { message: "ROOT_PERSON_XREF environment variable is not set. Set it to your GEDCOM cross-reference ID (e.g. @I1@) to use this tool." };
  }

  const { data: rootRows, error: rootErr } = await supabase
    .from("ancestors")
    .select("id, name, sex")
    .eq("gedcom_xref", rootXref)
    .limit(1);

  if (rootErr) throw rootErr;
  if (!rootRows?.length) {
    return { message: `Could not find root person with GEDCOM xref "${rootXref}".` };
  }
  const rootPerson = rootRows[0];

  let targetPerson: Record<string, unknown> | null = null;
  if (args.ancestor_id) {
    const { data, error } = await supabase
      .from("ancestors")
      .select("id, name, sex")
      .eq("id", args.ancestor_id)
      .limit(1);
    if (error) throw error;
    if (!data?.length) return { message: `No ancestor found with ID "${args.ancestor_id}".` };
    targetPerson = data[0];
  } else if (args.ancestor_name) {
    const resolved = await resolveAncestorByName(supabase, args.ancestor_name as string);
    if (!resolved) return { message: `No ancestor found matching "${args.ancestor_name}".` };
    const { data, error } = await supabase
      .from("ancestors")
      .select("id, name, sex")
      .eq("id", resolved.id)
      .limit(1);
    if (error) throw error;
    targetPerson = data?.[0] ?? null;
  } else {
    return { message: "Please provide an ancestor_name or ancestor_id." };
  }

  if (!targetPerson) return { message: "Could not resolve target ancestor." };

  if (rootPerson.id === targetPerson.id) {
    return { message: "That's you!" };
  }

  const { data: rels, error: relErr } = await supabase.rpc("find_relationship", {
    person_a: rootPerson.id,
    person_b: targetPerson.id,
    max_depth: 30,
  });

  if (relErr) throw relErr;
  if (!rels?.length) {
    return { message: `No relationship found between you (${rootPerson.name}) and ${targetPerson.name} within 30 generations.` };
  }

  const best = rels[0];
  const label = getRelationshipLabel(
    best.generations_from_a,
    best.generations_from_b,
    targetPerson.sex as string | null
  );

  const lines = [`${targetPerson.name} is ${label}.`];

  if (best.path_from_a && best.path_from_a.length > 2) {
    const pathDesc = await buildPathDescription(supabase, best.path_from_a);
    if (pathDesc) lines.push(`Connection: ${pathDesc}.`);
  }

  lines.push(
    `Common ancestor: ${best.common_ancestor_name} (${best.generations_from_a} generation${best.generations_from_a !== 1 ? "s" : ""} from you, ${best.generations_from_b} generation${best.generations_from_b !== 1 ? "s" : ""} from them).`
  );

  if (best.path_from_a && best.path_from_a.length > 0) {
    const trace = await buildLineageTrace(
      supabase,
      best.path_from_a,
      best.path_from_b || [targetPerson.id as string]
    );
    lines.push("", "Lineage trace:");
    lines.push(trace.join(" → "));
  }

  if (rels.length > 1) {
    lines.push("", "Other common ancestors:");
    for (let i = 1; i < rels.length; i++) {
      lines.push(`  ${rels[i].common_ancestor_name} (${rels[i].generations_from_a} gen / ${rels[i].generations_from_b} gen)`);
    }
  }

  return { message: lines.join("\n") };
}

function formatStatsText(stats: Awaited<ReturnType<typeof buildStats>>) {
  const lines = [
    `Total ancestors: ${stats.total}`,
    `Male: ${stats.sex_breakdown.M} | Female: ${stats.sex_breakdown.F}${stats.sex_breakdown.unknown ? ` | Unknown: ${stats.sex_breakdown.unknown}` : ""}`,
  ];

  if (stats.birth_year_range) {
    lines.push(`Birth year range: ${stats.birth_year_range.earliest} - ${stats.birth_year_range.latest}`);
  }
  if (stats.death_year_range) {
    lines.push(`Death year range: ${stats.death_year_range.earliest} - ${stats.death_year_range.latest}`);
  }
  if (stats.countries.length) {
    lines.push("", "Countries / Regions:");
    for (const entry of stats.countries) {
      lines.push(`  ${entry.name}: ${entry.count}`);
    }
  }
  if (stats.top_surnames.length) {
    lines.push("", "Top surnames:");
    for (const entry of stats.top_surnames) {
      lines.push(`  ${entry.name}: ${entry.count}`);
    }
  }

  return lines.join("\n");
}

function formatAncestor(person: Record<string, unknown>) {
  const lines = [String(person.name ?? "Unknown")];
  const sex = person.sex ? String(person.sex) : "";
  if (sex) {
    lines[0] += ` (${sex === "M" ? "Male" : sex === "F" ? "Female" : sex})`;
  }

  const born = [person.birth_date, person.birth_place].filter(Boolean).join(", ");
  const died = [person.death_date, person.death_place].filter(Boolean).join(", ");

  if (born) lines.push(`  Born: ${born}`);
  if (died) lines.push(`  Died: ${died}`);
  if (person.burial_place) lines.push(`  Buried: ${String(person.burial_place)}`);

  return lines.join("\n");
}

function formatSearchText(result: Awaited<ReturnType<typeof searchAncestors>>) {
  if (!result.results.length) {
    return "No ancestors found.";
  }

  const lines = result.results.map((person) => formatAncestor(person));
  if (result.lineage?.length) {
    lines.push("", "Lineage:");
    for (const row of result.lineage) {
      lines.push(`Generation ${row.generation}: ${formatAncestor(row)}`);
    }
  }

  return lines.join("\n\n");
}

async function handleMcpRequest(req: Request, supabase: ReturnType<typeof createClient>) {
  const server = new McpServer(
    {
      name: "ancestry-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
    "ancestor_stats",
    {
      description:
        "Get a high-level summary of your family tree: counts, countries/regions, top surnames, birth/death ranges, and male/female breakdown.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const stats = await buildStats(supabase);
      return { content: [{ type: "text", text: formatStatsText(stats) }] };
    }
  );

  server.registerTool(
    "find_ancestors",
    {
      description:
        "Search the family tree by name, dates, places, surname, sex, and optionally trace lineage.",
      inputSchema: z.object({
        name: z.string().optional(),
        given_name: z.string().optional(),
        surname: z.string().optional(),
        birth_date: z.string().optional(),
        birth_year_from: z.number().optional(),
        birth_year_to: z.number().optional(),
        birth_place: z.string().optional(),
        death_date: z.string().optional(),
        death_year_from: z.number().optional(),
        death_year_to: z.number().optional(),
        death_place: z.string().optional(),
        burial_place: z.string().optional(),
        sex: z.string().optional(),
        lineage: z.boolean().optional(),
        generations: z.number().optional(),
        limit: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: unknown) => {
      const result = await searchAncestors(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: formatSearchText(result) }] };
    }
  );

  server.registerTool(
    "capture_ancestor_note",
    {
      description:
        "Save a personal note about an ancestor. Automatically generates a semantic embedding and extracts metadata. Optionally links the note to a specific ancestor by fuzzy name.",
      inputSchema: z.object({
        content: z.string(),
        ancestor_name: z.string().optional(),
      }),
    },
    async (args: unknown) => {
      const result = await captureAncestorNote(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  server.registerTool(
    "search_ancestor_notes",
    {
      description:
        "Search personal ancestor notes by meaning. Supports optional ancestor filter, result limit, and similarity threshold.",
      inputSchema: z.object({
        query: z.string(),
        ancestor_name: z.string().optional(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: unknown) => {
      const result = await searchAncestorNotes(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  server.registerTool(
    "list_ancestor_notes",
    {
      description:
        "List personal ancestor notes, optionally filtered by type, topic, ancestor name, or recent days.",
      inputSchema: z.object({
        limit: z.number().optional(),
        type: z.string().optional(),
        topic: z.string().optional(),
        ancestor_name: z.string().optional(),
        days: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: unknown) => {
      const result = await listAncestorNotes(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  server.registerTool(
    "find_relationship",
    {
      description:
        "Find how an ancestor is related to you (e.g. '2nd cousin twice removed through your father\\'s mother'). Requires ROOT_PERSON_XREF env var.",
      inputSchema: z.object({
        ancestor_name: z.string().optional(),
        ancestor_id: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: unknown) => {
      const result = await findRelationship(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireSupabaseServiceRoleKey(), {
      auth: { persistSession: false },
    });
    const url = new URL(req.url);
    const action = getAction(url);
    const baseUrl = getBaseUrl(url, "ancestry");

    if (action === ".well-known/oauth-protected-resource" || action === "mcp/.well-known/oauth-protected-resource") {
      return protectedResourceMetadata(baseUrl);
    }
    if (action === ".well-known/oauth-authorization-server" || action === "mcp/.well-known/oauth-authorization-server") {
      return oauthMetadata(baseUrl);
    }
    if (req.method === "POST" && action === "oauth/token") {
      return await handleOAuthToken(req);
    }

    await requireAuth(req);

    if ((action === "" || action === "mcp") && (req.method === "POST" || req.method === "GET")) {
      return await handleMcpRequest(req, supabase);
    }

    if (req.method === "GET" && action === "stats") {
      return jsonResponse(await buildStats(supabase));
    }

    if (req.method === "POST" && action === "find") {
      return jsonResponse(await searchAncestors(supabase, await req.json()));
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});