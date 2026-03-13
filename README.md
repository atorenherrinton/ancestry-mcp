# Open Brain Ancestry MCP

Standalone MCP server for ancestry and lineage queries, now compatible with Supabase-hosted Postgres and Edge Functions.

## Tools

- `ancestor_stats`
- `find_ancestors`

## Quick Start

1. Install deps:

```bash
npm install
```

2. Create `.env`:

```bash
cp .env.docker.example .env
```

3. Start DB:

```bash
npm run docker:up
```

4. Run GEDCOM import:

```bash
npm run import:ancestors -- --file /absolute/path/to/tree.ged
```

5. Start MCP server:

```bash
npm run start:mcp
```

For Supabase deployment, see [SUPABASE.md](./SUPABASE.md).

## Database

- Database name: `ancestry`
- Local docker port: `5435`
- Schema file: `schema.sql`
