# my-universal-template

Universal full-stack TypeScript monorepo with end-to-end type safety via Hono RPC.

## Stack

| Layer      | Tech                                                          |
| ---------- | ------------------------------------------------------------ |
| Monorepo   | pnpm workspaces + Turborepo                                  |
| API        | Hono.js on Node (`@hono/node-server`) + Better Auth          |
| Database   | PostgreSQL + Drizzle ORM                                     |
| Admin      | Vite + React 19 + Tailwind CSS v4                            |
| Client     | Next.js 15 (App Router) + React 19 + Tailwind CSS v4         |
| Data layer | TanStack Query v5 + Hono RPC client (`hono/client`)          |
| Tooling    | Biome (lint + format)                                        |

## Layout

```
apps/
  api/      Hono backend, exports `AppType`
  admin/    Vite SPA, imports AppType → hc<AppType>()
  client/   Next.js SSR app, server-side hc<AppType>()
packages/
  tsconfig/ shared TS configs
```

The type-safety link: `apps/api/src/index.ts` exports `AppType = typeof routes`.
Both frontends depend on `api` via `workspace:*` and feed that type to
`hc<AppType>()`, so routes, params, and responses are inferred with no codegen.

## Getting started

```bash
pnpm install

# 1. Configure the API
cp apps/api/.env.example apps/api/.env   # then edit DATABASE_URL etc.

# 2. Push the schema to Postgres
pnpm --filter api db:push

# 3. Run everything
pnpm dev
```

- API:    http://localhost:3000
- Admin:  http://localhost:5173 (proxies `/api` → API)
- Client: http://localhost:3001

## Commands

| Command         | Description                        |
| --------------- | ---------------------------------- |
| `pnpm dev`      | Run all apps in dev (Turbo)        |
| `pnpm build`    | Build all apps (`^build` ordered)  |
| `pnpm lint`     | Biome check                        |
| `pnpm check`    | Biome check + autofix              |
| `pnpm db:push`  | Drizzle push schema                |
