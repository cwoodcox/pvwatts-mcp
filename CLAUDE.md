# Claude notes for pvwatts-mcp

This repo is the implementation of [`spec.md`](./spec.md) — read it first, it's the source of truth for what this server does and why each default is what it is. **Don't change a default in `src/defaults.ts` without checking the rationale column in the spec.**

## Stack at a glance

- Cloudflare Worker, TypeScript, `@modelcontextprotocol/sdk` + `agents/mcp`.
- One Durable Object (`PVWattsMCP`) holds MCP session state — bound as `MCP_OBJECT`. Migration tag `v1` uses `new_sqlite_classes` (free-plan compatible).
- Stateless from the app's perspective; an isolate-local LRU cache lives inside `pvwatts.ts`.
- Single secret: `NREL_API_KEY`.

## File responsibilities

| File | Holds | Don't put here |
|------|-------|-----------------|
| `src/index.ts` | Routing only — `/mcp`, `/sse`, `/health`. | Business logic. |
| `src/mcp.ts` | Tool registrations, arg coercion, response shaping, caveats. | NLR fetch logic. |
| `src/pvwatts.ts` | NLR HTTP call, retry, cache, error mapping, response normalization. | MCP/zod concerns. |
| `src/defaults.ts` | Numeric constants + caveat strings. | Anything with logic. |

## Gotchas

- **NLR returns HTTP 200 on validation errors.** Always check `errors[]` on the parsed body before trusting the response. `runPVWatts` already does this — preserve that behavior.
- **`agents/mcp` only loads in the Workers runtime.** Don't try to import it from Node scripts (`cloudflare:` URL scheme imports). Test through `wrangler dev` or the deployed Worker.
- **`tsc --noEmit` is sufficient** as a local check — but `npx wrangler deploy --dry-run --outdir=.wrangler/build` is what actually proves the bundle assembles for the Worker runtime. Run it before declaring a change shipped.
- **`worker-configuration.d.ts` is generated** by `npx wrangler types` and is gitignored. Re-run it after adding bindings.
- **Caching is intentional.** PVWatts is deterministic given inputs, and the underlying NSRDB station doesn't change between calls. Don't add cache-busting unless someone breaks that invariant.
- **Rate limits.** Default NLR key allows 1,000 req/hour. The adapter surfaces `X-RateLimit-Remaining` as a structured warning when it drops below 100. We don't try to budget proactively — if we hit 429, we wait once then surface the reset time.

## When extending

- **New PVWatts parameter** → add to `PVWattsParams` in `pvwatts.ts`, plumb through `buildUrl`, expose it in `pvwatts_run`'s zod schema in `mcp.ts`. Don't bake it into `solar_potential_for_acres` unless it's project-relevant.
- **Adding tracker-vs-fixed comparison logic** to the convenience tool — re-read spec.md § "What's deliberately out of scope" first. The spec is opinionated about keeping v1 narrow.
- **New tool** → register inside `PVWattsMCP.init()` with a JSON-stringified text response. Follow the `jsonContent` / `errorContent` / `formatError` pattern already in `mcp.ts`.

## Conventions in this repo

- Comments explain **why**, not what. The reader can read the code.
- Lean on `spec.md` rather than re-documenting decisions in code comments. If you change a decision, update the spec.
- Atomic commits per logical change (scaffold, adapter, tools, docs). Subjects use lowercase prefix like `adapter:`, `mcp:`, `docs:`.
