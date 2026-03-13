# Docker Runbook

For Supabase deployment and Edge Functions, see [SUPABASE.md](./SUPABASE.md).

## 1) Prepare env

```bash
cp .env.docker.example .env
```

## 2) Start database

```bash
npm run docker:up
```

## 3) Follow logs

```bash
npm run docker:logs
```

## 4) Run MCP in Docker (stdio)

```bash
npm run docker:mcp
```

## 5) Stop services

```bash
npm run docker:down
```
