/**
 * DEV/BOOTSTRAP TOOL - creates the first mission commander account.
 * Reads email and password from the terminal, hashes with bcrypt and writes
 * a single admin user. Does not require an SMTP service.
 *
 *   npm run create-admin
 */
import readline from 'node:readline/promises';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200);

// Hide password echo while keeping the normal readline prompt machinery.
function makeHiddenReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const originalWrite = rl._writeToOutput.bind(rl);
  let muted = false;
  rl._writeToOutput = (str) => {
    if (!muted) originalWrite(str);
  };
  return {
    rl,
    async askHidden(question) {
      process.stdout.write(question);
      muted = true;
      const answer = await rl.question('');
      muted = false;
      process.stdout.write('\n');
      return answer;
    },
  };
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('create-admin is a development/bootstrap tool; set NODE_ENV=development.');
    process.exit(1);
  }

  const { rl, askHidden } = makeHiddenReader();
  try {
    console.log(`Creating an admin account in "${env.DB_NAME}".`);
    const rawEmail = (await rl.question('Admin email: ')).trim();
    const emailResult = emailSchema.safeParse(rawEmail);
    if (!emailResult.success) {
      console.error('That email is not valid.');
      process.exitCode = 1;
      return;
    }
    const password = await askHidden('Password (input hidden): ');
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      console.error(passwordResult.error.issues[0].message);
      process.exitCode = 1;
      return;
    }
    const name = (await rl.question('Display name [Mission Commander]: ')).trim() || 'Mission Commander';

    const email = emailResult.data;
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      console.error('A user with that email already exists.');
      process.exitCode = 1;
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', 1)`,
      [name, email, passwordHash],
    );
    console.log(`Admin created: ${email}`);
  } finally {
    await rl.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to create admin:', err.message);
  process.exitCode = 1;
});
