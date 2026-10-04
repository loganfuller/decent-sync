---
status: accepted (amended by ADR-0016)
---

# TypeScript throughout: NestJS and Prisma on the server, a React SPA with shadcn/ui

The plugin and the server are both written in TypeScript. The server uses NestJS with Prisma over PostgreSQL (ADR-0007). The management interface is a React single-page app built with Vite and shadcn/ui, served as static files by the Nest server. This replaces the prototype's plain JavaScript with no build step: the server now needs a database, a REST API, auth and a UI, and the plugin and server share one wire contract that types can check.

We chose a Vite SPA over Next.js because a dashboard behind a login gains little from server rendering. Next.js would add a second server, with its own API routes and auth, next to Nest. With one process, the management interface uses the same REST API as every other client (ADR-0009).

## Consequences

- Decaid runs one ES2020 `plugin.js` with no modules, and installs whatever is committed. The plugin's TypeScript is bundled by esbuild into that single file, and the build output is committed. CI fails if the committed file doesn't match a fresh build. The dev harness runs the built file.
- One server instance is enough for v1, and the server needs only PostgreSQL. To scale out later, use Postgres `LISTEN/NOTIFY` to fan library changes out to whichever instance holds a tablet's WebSocket.
