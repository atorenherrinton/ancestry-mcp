# Setup

## Requirements

- Node.js 20+
- Docker (recommended for local DB)

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Configure env:

```bash
cp .env.docker.example .env
```

3. Start Postgres and schema:

```bash
npm run docker:up
```

4. Import family tree data:

```bash
npm run import:ancestors -- --file /path/to/tree.ged
```

5. Run the MCP server:

```bash
npm run start:mcp
```

6. Optional smoke test:

```bash
npm run test:mcp-init
```
