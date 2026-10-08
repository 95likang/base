import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: fail fast if DATABASE_URL is missing at migration time.
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
})
