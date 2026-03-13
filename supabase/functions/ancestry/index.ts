import { createClient } from "npm:@supabase/supabase-js@2";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "npm:zod@3.24.1";

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

function requireOptionalKey(req: Request) {
  const expected = Deno.env.get("ANCESTRY_ACCESS_KEY") ?? "";
  if (!expected) {
    return;
  }

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
    async (args) => {
      const result = await searchAncestors(supabase, args as Record<string, unknown>);
      return { content: [{ type: "text", text: formatSearchText(result) }] };
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
    requireOptionalKey(req);

    const supabase = createClient(requireEnv("SUPABASE_URL"), requireSupabaseServiceRoleKey(), {
      auth: { persistSession: false },
    });
    const url = new URL(req.url);
    const action = getAction(url);

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