# Supabase Setup

This repo now supports Supabase-hosted Postgres for both the MCP server and the GEDCOM import script, and it includes an Edge Function for ancestry lookup APIs.

## 1. Prerequisites

Install the Supabase CLI and authenticate:

```bash
brew install supabase/tap/supabase
supabase login
```

## 2. Configure env

```bash
cp .env.example .env
```

Fill in:

- `SUPABASE_DB_URL`: pooled Postgres connection string
- `SUPABASE_URL`: project URL
- `SUPABASE_SECRET_KEY`: optional custom name for the Edge Function service-role key
- `ANCESTRY_ACCESS_KEY`: optional shared secret for the Edge Function

The Node runtime accepts either `SUPABASE_DB_URL` or the old `DATABASE_URL`.
The Edge Function accepts either `SUPABASE_SECRET_KEY` or Supabase's built-in `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Link the repo

```bash
supabase init
supabase link --project-ref your-project-ref
```

## 4. Push the schema

```bash
npm run supabase:db:push
```

If you prefer the SQL editor, run [supabase/migrations/202603130001_ancestry.sql](supabase/migrations/202603130001_ancestry.sql).

## 5. Import your GEDCOM data

After the schema is live, the existing importer can load the hosted database directly:

```bash
npm install
npm run import:ancestors -- --file /absolute/path/to/tree.ged
```

## 6. Deploy the Edge Function

```bash
npm run supabase:functions:deploy
```

Routes:

- `GET /functions/v1/ancestry/stats`
- `POST /functions/v1/ancestry/find`
- `POST /functions/v1/ancestry/mcp`

If `ANCESTRY_ACCESS_KEY` is set, send it as `x-ancestry-key`.

## 7. Gemini CLI configuration

Gemini CLI can now connect directly to the deployed Edge Function over HTTP MCP.

```bash
gemini mcp add --transport http ancestry-mcp https://kmnmzikkmvicbbwjiqbb.supabase.co/functions/v1/ancestry/mcp \
	--scope user \
	--description "Ancestry MCP over Supabase Edge Function" \
	--trust \
	-H "x-ancestry-key: YOUR_ANCESTRY_ACCESS_KEY"
```

Or copy [gemini-settings.example.json](./gemini-settings.example.json) into `~/.gemini/settings.json` and replace the placeholder key.

Verify the server is visible:

```bash
gemini mcp list
```

## 8. Keep using the local MCP server if you want

The local stdio MCP server still works too:

```bash
npm run start:mcp
```