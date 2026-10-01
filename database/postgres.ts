import pg from "pg";

const { Pool } = pg;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required PostgreSQL environment variable: ${name}`);
  }

  return value;
}

export const db = new Pool({
  host: requiredEnv("DB_HOST"),
  port: Number(process.env.DB_PORT || "5432"),
  database: requiredEnv("DB_NAME"),
  user: requiredEnv("DB_USER"),
  password: requiredEnv("DB_PASSWORD"),

  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

db.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

export async function testDatabaseConnection(): Promise<void> {
  const result = await db.query<{
    database: string;
    db_user: string;
  }>(`
    SELECT
      current_database() AS database,
      current_user AS db_user
  `);

  console.log(
    `PostgreSQL connected: database=${result.rows[0].database}, user=${result.rows[0].db_user}`
  );
}

export async function closeDatabase(): Promise<void> {
  await db.end();
}
