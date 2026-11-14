/**
 * Import database/vitalis.sql into any MySQL/MariaDB server.
 *
 * Usage:
 *   DATABASE_URL="mysql://user:pass@host:3306/dbname?ssl-mode=required" \
 *     node scripts/import-dump.js
 *
 *   # or with the DB_* variables from .env
 *   node scripts/import-dump.js
 *
 * Options:
 *   --file <path>   Dump to import (default: database/vitalis.sql)
 *   --dry-run       Parse and report statements without touching the database
 *
 * The dump contains DROP TABLE / CREATE TABLE / INSERT only, so it replaces the
 * schema of the target database. It never creates or drops the database itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import mysql from 'mysql2/promise';
import { env, SERVER_ROOT } from '../src/config/env.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArgIndex = args.indexOf('--file');
const dumpPath = fileArgIndex !== -1
  ? path.resolve(args[fileArgIndex + 1])
  : path.join(SERVER_ROOT, 'database', 'vitalis.sql');

/**
 * Split mysqldump output into single statements without breaking on semicolons
 * inside quoted strings or /* ... *\/ comments.
 */
function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  let quote = null;

  while (i < sql.length) {
    const char = sql[i];

    if (quote) {
      if (char === '\\' && quote !== '`') {
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      i += 1;
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (
      (char === '-' && sql[i + 1] === '-' && /[\s]/.test(sql[i + 2] ?? ' ')) ||
      char === '#'
    ) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function connectionOptions() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.JAWSDB_URL;

  if (url) {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const sslMode = params.get('ssl-mode') || params.get('sslmode') || '';
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, '') || undefined,
      ssl: /required|verify/i.test(sslMode) || env.DB_SSL
        ? { rejectUnauthorized: false }
        : undefined,
      label: `${parsed.hostname}:${parsed.port || 3306}/${parsed.pathname.replace(/^\//, '')}`,
    };
  }

  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
    label: `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
  };
}

async function main() {
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump not found: ${dumpPath}`);
  }

  console.log(`Dump:  ${dumpPath} (${(fs.statSync(dumpPath).size / 1024 / 1024).toFixed(2)} MiB)`);

  const sql = fs.readFileSync(dumpPath, 'utf8');
  const statements = splitStatements(sql);
  const inserts = statements.filter((s) => /^INSERT INTO/i.test(s));
  const creates = statements.filter((s) => /^CREATE TABLE/i.test(s));
  console.log(`Parsed: ${statements.length} statements (${creates.length} CREATE TABLE, ${inserts.length} INSERT)`);

  if (dryRun) {
    console.log('Dry run: no connection made.');
    return;
  }

  const { label, ...connectionConfig } = connectionOptions();
  console.log(`Target: ${label}${connectionConfig.ssl ? ' (TLS)' : ''}`);

  const connection = await mysql.createConnection({
    ...connectionConfig,
    multipleStatements: false,
    charset: 'utf8mb4',
    connectTimeout: 20_000,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });

  const started = Date.now();
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('SET UNIQUE_CHECKS = 0');

    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      try {
        await connection.query(statement);
      } catch (error) {
        const preview = statement.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`Statement ${index + 1} failed: ${error.message}\n  ${preview}...`);
      }
      if ((index + 1) % 10 === 0) {
        process.stdout.write(`\r  ${index + 1}/${statements.length} statements`);
      }
    }
    process.stdout.write(`\r  ${statements.length}/${statements.length} statements\n`);

    await connection.query('SET UNIQUE_CHECKS = 1');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    const tables = ['users', 'readings', 'environment_readings', 'radiation_readings', 'alerts'];
    const counts = {};
    for (const table of tables) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      counts[table] = Number(rows[0].n);
    }

    console.log(`Imported in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`  ${table.padEnd(22)} ${count}`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`\nImport failed: ${error.message}`);
  process.exit(1);
});
