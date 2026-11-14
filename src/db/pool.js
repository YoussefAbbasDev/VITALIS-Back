import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

// One shared pool for the whole process. Monitoring tables are read-only for
// the API; writes are limited to the tables listed in the project README.
// Serverless platforms (Vercel) run many short-lived instances, so keep the
// pool small there and let Fluid compute reuse the instance between requests.
const connectionLimit = env.IS_VERCEL
  ? Math.min(env.DB_POOL_SIZE, 5)
  : env.DB_POOL_SIZE;

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit,
  queueLimit: 0,
  connectTimeout: 10_000,
  timezone: 'Z',
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: false,
  // Managed MySQL providers usually present a certificate that the function
  // cannot verify against the bundled CA list.
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
});

// Force UTC on every pooled connection so SQL NOW()/CURRENT_TIMESTAMP and the
// JS-generated timestamps agree (the API serializes times as UTC ISO strings).
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function pingDatabase() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}
