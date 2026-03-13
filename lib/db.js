const { Pool } = require("pg");

function getDatabaseUrl() {
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
}

function shouldUseSsl(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname;
    return (
      hostname.includes("supabase.co") ||
      hostname.includes("supabase.com") ||
      hostname.includes("pooler")
    );
  } catch {
    return false;
  }
}

function createPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("Missing SUPABASE_DB_URL or DATABASE_URL");
  }

  const config = { connectionString };
  if (shouldUseSsl(connectionString) && !/sslmode=disable/i.test(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }

  return new Pool(config);
}

module.exports = {
  createPool,
  getDatabaseUrl,
};