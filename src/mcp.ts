import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";

import { monthlyGenerationCard, solarPotentialCard } from "./cards.js";
import { CAVEATS, DEFAULTS } from "./defaults.js";
import { PVWattsError, runPVWatts, type PVWattsResult } from "./pvwatts.js";

interface Env {
  NREL_API_KEY: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// PVWatts v8 supports system_capacity 0.05 – 500,000 kW DC.
const SYSTEM_CAPACITY_MIN_KW = 0.05;
const SYSTEM_CAPACITY_MAX_KW = 500_000;

const DATASETS = ["nsrdb", "tmy2", "tmy3", "intl"] as const;

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function describeConfiguration(arrayType: number, tilt: number): string {
  switch (arrayType) {
    case 0:
      return `fixed-tilt-${tilt}deg`;
    case 1:
      return `fixed-roof-${tilt}deg`;
    case 2:
      return "1-axis-tracker";
    case 3:
      return "1-axis-backtracking";
    case 4:
      return "2-axis-tracker";
    default:
      return `array_type=${arrayType}`;
  }
}

export class PVWattsMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "pvwatts-mcp",
    version: "0.1.0",
  });

  async init() {
    this.server.tool(
      "pvwatts_run",
      "Faithful wrapper around NREL PVWatts v8. Use to override defaults — compare fixed-tilt vs. tracker, model a roof system, change tilt for site-specific topography. Returns annual + monthly AC/DC kWh, GHI/POA irradiance, capacity factor, and the nearest NSRDB station info.",
      {
        lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees."),
        lon: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
        system_capacity_kw: z
          .number()
          .min(SYSTEM_CAPACITY_MIN_KW)
          .max(SYSTEM_CAPACITY_MAX_KW)
          .describe("System size in kW DC. PVWatts supports 0.05 – 500,000."),
        module_type: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe("0 = standard, 1 = premium, 2 = thin film. Default 0."),
        array_type: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe(
            "0 = fixed open rack, 1 = fixed roof, 2 = 1-axis tracker, 3 = 1-axis backtracking, 4 = 2-axis tracker. Default 0.",
          ),
        tilt: z
          .number()
          .min(0)
          .max(90)
          .optional()
          .describe("Tilt from horizontal in degrees. Default 25."),
        azimuth: z
          .number()
          .min(0)
          .max(360)
          .optional()
          .describe("Degrees from north, clockwise. 180 = south-facing. Default 180."),
        losses: z
          .number()
          .min(-5)
          .max(99)
          .optional()
          .describe("System losses as a percentage. Default 14.08 (NREL published default)."),
        dc_ac_ratio: z.number().min(0.1).max(2.5).optional().describe("Default 1.2."),
        gcr: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Ground coverage ratio. Ignored for non-tracker arrays. Default 0.4."),
        inv_eff: z
          .number()
          .min(90)
          .max(99.5)
          .optional()
          .describe("Inverter efficiency percentage. Default 96."),
        bifaciality: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0–1. Skip unless explicitly modeling bifacial modules."),
        dataset: z
          .enum(DATASETS)
          .optional()
          .describe("Weather dataset. Default 'nsrdb'."),
      },
      async (args) => {
        try {
          const result = await runPVWatts(
            {
              lat: args.lat,
              lon: args.lon,
              system_capacity_kw: args.system_capacity_kw,
              module_type: args.module_type ?? DEFAULTS.module_type,
              array_type: args.array_type ?? DEFAULTS.array_type,
              tilt: args.tilt ?? DEFAULTS.tilt,
              azimuth: args.azimuth ?? DEFAULTS.azimuth,
              losses: args.losses ?? DEFAULTS.losses,
              dc_ac_ratio: args.dc_ac_ratio ?? DEFAULTS.dc_ac_ratio,
              gcr: args.gcr ?? DEFAULTS.gcr,
              inv_eff: args.inv_eff ?? DEFAULTS.inv_eff,
              bifaciality: args.bifaciality,
              dataset: args.dataset ?? DEFAULTS.dataset,
            },
            this.env.NREL_API_KEY,
          );
          return jsonContent(result);
        } catch (err) {
          return errorContent(formatError(err));
        }
      },
    );

    this.server.tool(
      "solar_potential_for_acres",
      "Convenience wrapper. Takes a parcel centroid + acreage, applies Watts-for-Water project defaults (Utah utility-scale, fixed-tilt 25°, $35/MWh wholesale), and returns annual MWh, capacity factor, indicative revenue, and explicit caveats. Set tracker=true to model 1-axis backtracking (typical ~15–20% yield boost).",
      {
        lat: z.number().min(-90).max(90).describe("Parcel centroid latitude."),
        lon: z.number().min(-180).max(180).describe("Parcel centroid longitude."),
        acres: z
          .number()
          .positive()
          .describe("Parcel acreage to allocate to solar."),
        tracker: z
          .boolean()
          .optional()
          .describe(
            "If true, sets array_type=3 (1-axis backtracking) and gcr=0.35. Default false.",
          ),
        acres_per_mw_dc: z
          .number()
          .positive()
          .optional()
          .describe("Override the default density assumption (8 acres/MW DC for fixed-tilt)."),
        price_per_mwh_usd: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Indicative wholesale rate. Default 35 ≈ PacifiCorp avoided cost. Real PPA terms are typically $50–80/MWh.",
          ),
      },
      async (args) => {
        try {
          const acresPerMw = args.acres_per_mw_dc ?? DEFAULTS.acres_per_mw_dc;
          const pricePerMwh = args.price_per_mwh_usd ?? DEFAULTS.price_per_mwh_usd;
          const tracker = args.tracker ?? false;
          const systemCapacityKw = (args.acres / acresPerMw) * 1000;

          const arrayType = tracker ? DEFAULTS.tracker_array_type : DEFAULTS.array_type;
          const gcr = tracker ? DEFAULTS.tracker_gcr : DEFAULTS.gcr;

          const pv: PVWattsResult = await runPVWatts(
            {
              lat: args.lat,
              lon: args.lon,
              system_capacity_kw: systemCapacityKw,
              module_type: DEFAULTS.module_type,
              array_type: arrayType,
              tilt: DEFAULTS.tilt,
              azimuth: DEFAULTS.azimuth,
              losses: DEFAULTS.losses,
              dc_ac_ratio: DEFAULTS.dc_ac_ratio,
              gcr,
              inv_eff: DEFAULTS.inv_eff,
              dataset: DEFAULTS.dataset,
            },
            this.env.NREL_API_KEY,
          );

          const generationMwh = pv.annual.ac_kwh / 1000;
          const indicativeRevenue = generationMwh * pricePerMwh;
          const systemCapacityMwDc = Number((systemCapacityKw / 1000).toFixed(3));
          const configuration = describeConfiguration(arrayType, DEFAULTS.tilt);
          const monthlyMwh = pv.monthly.ac_kwh.map((kwh) => Math.round(kwh / 1000));
          const annualGenerationMwh = Math.round(generationMwh);
          const capacityFactorPct = Number(pv.annual.capacity_factor_pct.toFixed(1));
          const indicativeRevenueUsd = Math.round(indicativeRevenue);
          const ghi = Math.round(pv.annual.ghi_kwh_per_m2);

          const response: Record<string, unknown> = {
            inputs: {
              lat: args.lat,
              lon: args.lon,
              acres: args.acres,
              system_capacity_mw_dc: systemCapacityMwDc,
              configuration,
              price_per_mwh_usd: pricePerMwh,
            },
            annual: {
              generation_mwh: annualGenerationMwh,
              capacity_factor_pct: capacityFactorPct,
              indicative_revenue_usd: indicativeRevenueUsd,
              ghi_kwh_per_m2: ghi,
            },
            monthly_generation_mwh: monthlyMwh,
            caveats: CAVEATS,
          };

          if (pv.warnings.length > 0) response.warnings = pv.warnings;
          if (pv.rate_limit) response.rate_limit = pv.rate_limit;

          // Stable per-call URIs so MCP clients can distinguish (and cache) cards across runs.
          const slug = `${args.lat.toFixed(4)},${args.lon.toFixed(4)},${args.acres}`;
          const summaryResource = createUIResource({
            uri: `ui://solar-potential/${slug}`,
            content: {
              type: "rawHtml",
              htmlString: solarPotentialCard({
                lat: args.lat,
                lon: args.lon,
                acres: args.acres,
                system_capacity_mw_dc: systemCapacityMwDc,
                configuration,
                price_per_mwh_usd: pricePerMwh,
                annual_generation_mwh: annualGenerationMwh,
                capacity_factor_pct: capacityFactorPct,
                indicative_revenue_usd: indicativeRevenueUsd,
                ghi_kwh_per_m2: ghi,
                caveats: CAVEATS,
              }),
            },
            encoding: "text",
          });
          const monthlyResource = createUIResource({
            uri: `ui://solar-potential/${slug}/monthly`,
            content: {
              type: "rawHtml",
              htmlString: monthlyGenerationCard({
                lat: args.lat,
                lon: args.lon,
                monthly_generation_mwh: monthlyMwh,
                unit: "MWh",
              }),
            },
            encoding: "text",
          });

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(response, null, 2) },
              summaryResource,
              monthlyResource,
            ],
          };
        } catch (err) {
          return errorContent(formatError(err));
        }
      },
    );
  }
}

function formatError(err: unknown): string {
  if (err instanceof PVWattsError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `Unknown error: ${String(err)}`;
}
