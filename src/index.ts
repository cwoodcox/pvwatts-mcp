import { PVWattsMCP } from "./mcp.js";

interface Env {
  NREL_API_KEY: string;
  MCP_OBJECT: DurableObjectNamespace;
}

const ROOT_BODY = [
  "pvwatts-mcp — NLR PVWatts v8 wrapped as an MCP server.",
  "",
  "Transports:",
  "  POST /mcp   — streamable HTTP (recommended)",
  "  GET  /sse   — legacy Server-Sent Events",
  "",
  "Tools:",
  "  pvwatts_run                — faithful PVWatts v8 wrapper",
  "  solar_potential_for_acres  — convenience: acreage → MWh + indicative revenue",
  "",
  "Source: https://github.com/cwoodcox/pvwatts-mcp",
].join("\n");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return PVWattsMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return PVWattsMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(ROOT_BODY, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { PVWattsMCP };
