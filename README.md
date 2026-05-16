# pvwatts-mcp

MCP server wrapping [NLR PVWatts v8](https://developer.nlr.gov/docs/solar/pvwatts/v8/) for the **Watts for Water** project. Turns a parcel centroid + acreage into annual / monthly generation estimates suitable for revenue modeling and infographic headline numbers.

See [`spec.md`](./spec.md) for the design doc.

## Tools

| Tool | Purpose |
|------|---------|
| `pvwatts_run` | Faithful wrapper around PVWatts v8. All parameters exposed; project defaults applied when omitted. |
| `solar_potential_for_acres` | Convenience: acreage + centroid → MW DC → annual MWh, capacity factor, indicative revenue. `tracker=true` flips to 1-axis backtracking. |

## Setup

```bash
npm install
```

Get a free NLR API key at [developer.nlr.gov/signup](https://developer.nlr.gov/signup/), then store it as a Worker secret:

```bash
npx wrangler secret put NREL_API_KEY
```

For local development with `wrangler dev`, put the same key in a `.dev.vars` file at the repo root (gitignored):

```
NREL_API_KEY=your-key-here
```

## Running locally

```bash
npm run dev
```

Worker listens at `http://localhost:8787`. Test endpoints:

- `GET /` — plain-text usage hint
- `POST /mcp` — streamable HTTP transport (recommended)
- `GET /sse` — legacy SSE transport

Inspect with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
# Then open the URL it prints and connect to http://localhost:8787/mcp
```

## Deploying

```bash
npx wrangler deploy
```

Then connect from Claude Desktop via `mcp-remote`:

```json
{
  "mcpServers": {
    "pvwatts": {
      "command": "npx",
      "args": ["mcp-remote", "https://pvwatts-mcp.<your-account>.workers.dev/mcp"]
    }
  }
}
```

## Acceptance test

The MCP is ready to ship when this call returns sane numbers:

```jsonc
// Tool: solar_potential_for_acres
{
  "lat": 41.72,
  "lon": -111.83,    // Cache Valley, Utah
  "acres": 80,
  "tracker": false
}
```

Expected (per `spec.md` § Acceptance test, within ~10%):
- `system_capacity_mw_dc`: 10.0
- `annual.generation_mwh`: 21,000 – 24,000
- `annual.capacity_factor_pct`: 24 – 26
- `annual.indicative_revenue_usd`: ~$735K – $840K at $35/MWh
- Monthly trough in Dec/Jan (~1,000 MWh), peak in Jun/Jul (~2,400 MWh)

Re-running with `tracker=true` should bump annual generation to 25,000–28,000 MWh and capacity factor to ~28–30%, validating the array-type plumbing.

## Layout

```
src/
  index.ts      Worker entrypoint — routes /mcp and /sse
  mcp.ts        McpAgent subclass; tool registrations
  pvwatts.ts    NLR adapter — fetch, retry, cache, error mapping
  defaults.ts   Utah utility-scale assumption set + caveat strings
```
