// NREL PVWatts v8 adapter.
// Reference: https://developer.nrel.gov/docs/solar/pvwatts/v8/
//
// Responsibilities (per spec.md § Error handling and § Implementation recommendation):
//   - Build the query string, GET with 15s timeout, retry-once on 5xx.
//   - Non-empty errors[] → thrown error (NREL returns HTTP 200 even for validation failures).
//   - Non-empty warnings[] → passthrough on the returned object.
//   - 401 → clear "set NREL_API_KEY" message; 429 → wait + retry once, then surface reset time.
//   - Surface rate-limit-remaining when low.
//   - Isolate-local LRU cache (~1000 entries) keyed on canonical params.

const NREL_ENDPOINT = "https://developer.nrel.gov/api/pvwatts/v8.json";
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WARN_THRESHOLD = 100;
const CACHE_MAX_ENTRIES = 1000;

export interface PVWattsParams {
  lat: number;
  lon: number;
  system_capacity_kw: number;
  module_type: number;
  array_type: number;
  tilt: number;
  azimuth: number;
  losses: number;
  dc_ac_ratio: number;
  gcr: number;
  inv_eff: number;
  bifaciality?: number;
  dataset: string;
}

export interface PVWattsResult {
  inputs: {
    lat: number;
    lon: number;
    system_capacity_kw: number;
    array_type: number;
    tilt: number;
    azimuth: number;
    module_type: number;
    losses: number;
  };
  station: {
    lat: number;
    lon: number;
    elev_m: number;
    tz_offset: number;
    name: string;
    state: string;
  };
  annual: {
    ac_kwh: number;
    dc_kwh: number;
    capacity_factor_pct: number;
    ghi_kwh_per_m2: number;
    poa_kwh_per_m2: number;
  };
  monthly: {
    ac_kwh: number[];
    ghi_kwh_per_m2: number[];
    poa_kwh_per_m2: number[];
  };
  warnings: string[];
  rate_limit?: {
    remaining: number;
    limit: number;
    note: string;
  };
}

// NREL response shape — narrowed to the fields we read.
interface NrelResponse {
  errors?: string[];
  warnings?: string[];
  inputs?: Record<string, string | number>;
  station_info?: {
    lat?: number;
    lon?: number;
    elev?: number;
    tz?: number;
    location?: string;
    state?: string;
  };
  outputs?: {
    ac_annual?: number;
    ac_monthly?: number[];
    dc_monthly?: number[];
    poa_monthly?: number[];
    solrad_monthly?: number[];
    solrad_annual?: number;
    capacity_factor?: number;
  };
}

// Isolate-local LRU cache. A Map preserves insertion order in JS, so we can evict the
// oldest entry by deleting the first key. Re-insert on hit to bump recency.
const cache = new Map<string, PVWattsResult>();

function canonicalKey(p: PVWattsParams): string {
  // Round to a stable precision so trivially different floats don't fragment the cache.
  const round = (n: number, digits = 6) => Number(n.toFixed(digits));
  return JSON.stringify({
    lat: round(p.lat),
    lon: round(p.lon),
    system_capacity_kw: round(p.system_capacity_kw, 3),
    module_type: p.module_type,
    array_type: p.array_type,
    tilt: round(p.tilt, 3),
    azimuth: round(p.azimuth, 3),
    losses: round(p.losses, 3),
    dc_ac_ratio: round(p.dc_ac_ratio, 3),
    gcr: round(p.gcr, 3),
    inv_eff: round(p.inv_eff, 3),
    bifaciality: p.bifaciality == null ? null : round(p.bifaciality, 3),
    dataset: p.dataset,
  });
}

function cacheGet(key: string): PVWattsResult | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit); // bump to most-recent
  return hit;
}

function cacheSet(key: string, value: PVWattsResult): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export class PVWattsError extends Error {
  public readonly status?: number;
  public readonly nrelErrors?: string[];
  constructor(message: string, opts: { status?: number; nrelErrors?: string[] } = {}) {
    super(message);
    this.name = "PVWattsError";
    this.status = opts.status;
    this.nrelErrors = opts.nrelErrors;
  }
}

function buildUrl(params: PVWattsParams, apiKey: string): string {
  const q = new URLSearchParams({
    api_key: apiKey,
    lat: String(params.lat),
    lon: String(params.lon),
    system_capacity: String(params.system_capacity_kw),
    module_type: String(params.module_type),
    losses: String(params.losses),
    array_type: String(params.array_type),
    tilt: String(params.tilt),
    azimuth: String(params.azimuth),
    dc_ac_ratio: String(params.dc_ac_ratio),
    gcr: String(params.gcr),
    inv_eff: String(params.inv_eff),
    dataset: params.dataset,
    timeframe: "monthly",
  });
  if (params.bifaciality != null) {
    q.set("bifaciality", String(params.bifaciality));
  }
  return `${NREL_ENDPOINT}?${q.toString()}`;
}

async function doFetch(url: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function fetchWithRetry(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await doFetch(url);
  } catch (err) {
    // Network error or timeout. Retry once.
    response = await doFetch(url);
  }

  if (response.status >= 500 && response.status < 600) {
    // Retry once on 5xx. NREL's edge cache cold-start is the usual culprit.
    response = await doFetch(url);
  }

  if (response.status === 429) {
    // Rate-limited: wait briefly and retry once before giving up.
    await new Promise((r) => setTimeout(r, 1000));
    response = await doFetch(url);
  }

  return response;
}

function parseRateLimit(response: Response): { remaining: number; limit: number; reset?: string } | undefined {
  const remainingHeader = response.headers.get("X-RateLimit-Remaining");
  const limitHeader = response.headers.get("X-RateLimit-Limit");
  if (remainingHeader == null || limitHeader == null) return undefined;
  const remaining = Number(remainingHeader);
  const limit = Number(limitHeader);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return undefined;
  return {
    remaining,
    limit,
    reset: response.headers.get("X-RateLimit-Reset") ?? undefined,
  };
}

export async function runPVWatts(params: PVWattsParams, apiKey: string): Promise<PVWattsResult> {
  if (!apiKey) {
    throw new PVWattsError(
      "NREL_API_KEY is unset. Set it via `npx wrangler secret put NREL_API_KEY` (free key at https://developer.nrel.gov/signup).",
    );
  }

  const key = canonicalKey(params);
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = buildUrl(params, apiKey);
  const response = await fetchWithRetry(url);

  if (response.status === 401 || response.status === 403) {
    throw new PVWattsError(
      "NREL_API_KEY is invalid or unset — re-set via `wrangler secret put NREL_API_KEY`.",
      { status: response.status },
    );
  }

  if (response.status === 429) {
    const rl = parseRateLimit(response);
    const resetNote = rl?.reset ? ` Resets at ${rl.reset}.` : "";
    throw new PVWattsError(
      `NREL rate limit exhausted (HTTP 429).${resetNote} Default key is 1,000 req/hour.`,
      { status: 429 },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new PVWattsError(
      `NREL PVWatts returned HTTP ${response.status}. ${body.slice(0, 500)}`,
      { status: response.status },
    );
  }

  const data = (await response.json()) as NrelResponse;

  if (data.errors && data.errors.length > 0) {
    throw new PVWattsError(`NREL PVWatts validation error: ${data.errors.join("; ")}`, {
      nrelErrors: data.errors,
    });
  }

  const outputs = data.outputs ?? {};
  const station = data.station_info ?? {};

  // Defensive: PVWatts has historically always returned these for a successful call, but
  // a future schema change shouldn't bring down the whole tool with an unintelligible error.
  if (
    outputs.ac_annual == null ||
    !Array.isArray(outputs.ac_monthly) ||
    !Array.isArray(outputs.dc_monthly)
  ) {
    throw new PVWattsError(
      "NREL PVWatts response missing expected outputs (ac_annual / ac_monthly / dc_monthly).",
    );
  }

  const dcAnnual = outputs.dc_monthly.reduce((a, b) => a + b, 0);
  const poaAnnual = (outputs.poa_monthly ?? []).reduce((a, b) => a + b, 0);

  const result: PVWattsResult = {
    inputs: {
      lat: params.lat,
      lon: params.lon,
      system_capacity_kw: params.system_capacity_kw,
      array_type: params.array_type,
      tilt: params.tilt,
      azimuth: params.azimuth,
      module_type: params.module_type,
      losses: params.losses,
    },
    station: {
      lat: station.lat ?? params.lat,
      lon: station.lon ?? params.lon,
      elev_m: station.elev ?? 0,
      tz_offset: station.tz ?? 0,
      name: station.location ?? "",
      state: station.state ?? "",
    },
    annual: {
      ac_kwh: outputs.ac_annual,
      dc_kwh: dcAnnual,
      capacity_factor_pct: outputs.capacity_factor ?? 0,
      ghi_kwh_per_m2: outputs.solrad_annual ?? 0,
      poa_kwh_per_m2: poaAnnual,
    },
    monthly: {
      ac_kwh: outputs.ac_monthly,
      ghi_kwh_per_m2: outputs.solrad_monthly ?? [],
      poa_kwh_per_m2: outputs.poa_monthly ?? [],
    },
    warnings: data.warnings ?? [],
  };

  const rl = parseRateLimit(response);
  if (rl && rl.remaining < RATE_LIMIT_WARN_THRESHOLD) {
    result.rate_limit = {
      remaining: rl.remaining,
      limit: rl.limit,
      note: `NREL rate limit running low: ${rl.remaining}/${rl.limit} requests remaining this hour.`,
    };
  }

  cacheSet(key, result);
  return result;
}
