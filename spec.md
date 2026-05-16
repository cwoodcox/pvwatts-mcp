# NLR PVWatts MCP Server — v1 Spec

A Model Context Protocol server that wraps NLR's PVWatts v8 API for the Watts for Water project — turning per-parcel coordinates and a system size into annual / monthly generation estimates suitable for revenue modeling and infographic headline numbers.

The design goal is **two tools**: a generic `pvwatts_run` that exposes the underlying API faithfully, and a `solar_potential_for_acres` convenience that bakes in project-relevant defaults (utility-scale, fixed-tilt, Utah-typical) and returns the numbers the assistant actually wants — annual MWh, capacity factor, approximate revenue, and a sanity check on the irradiance input.

---

## Implementation recommendation

Match the UGRC MCP's stack exactly so the operational story stays uniform:

- **Runtime:** TypeScript on Cloudflare Workers, using [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and the Cloudflare Agents SDK ([`agents/mcp`](https://developers.cloudflare.com/agents/mcp/)) for streamable HTTP transport. ~150 lines for v1.
- **HTTP:** native `fetch`. Wrap in a small helper with `AbortSignal.timeout(15_000)` and retry once on 5xx. NLR's API is reliable but occasionally slow on cold edge cache.
- **Auth:** NREL API key, supplied via Worker secret. Free signup at [developer.nlr.gov/signup](https://developer.nlr.gov/signup/). Set via `npx wrangler secret put NREL_API_KEY`. Fail loudly with a clear error if `env.NREL_API_KEY` is empty.
- **State:** Stateless. MCP session state lives in a Durable Object (`McpAgent` from `agents/mcp`) — same pattern as UGRC.
- **Caching:** Isolate-local `Map<string, Response>` keyed on `(lat, lon, system_capacity, array_type, tilt, azimuth, module_type, losses)`. PVWatts is deterministic given inputs and the underlying NSRDB station for a given lat/lon doesn't change between calls — caching is safe and high-leverage. Cap at ~1000 entries per isolate; LRU eviction.
- **Rate limiting:** Default key is 1,000 requests/hour. v1 doesn't need a budget — the model won't run more than a few dozen lookups per session — but the implementer should pass through the `X-RateLimit-Remaining` and `X-RateLimit-Limit` headers from NLR into a structured warning if `X-RateLimit-Remaining < 100`.

Layout: `src/index.ts` (Worker entrypoint), `src/mcp.ts` (`McpAgent` + tool registrations), `src/pvwatts.ts` (NLR adapter), `src/defaults.ts` (Utah utility-scale assumption set). Local dev via `npm run dev` (wrangler), deploy via `npx wrangler deploy`.

---

## NLR PVWatts v8 — endpoint summary

- **URL:** `https://developer.nlr.gov/api/pvwatts/v8.json`
- **Method:** GET (or POST for very large parameter sets, but every parameter we use fits comfortably in a query string).
- **Auth:** `api_key` query parameter.
- **Required parameters:** `lat`, `lon`, `system_capacity` (kW DC), `module_type`, `losses` (% as float), `array_type`, `tilt` (degrees), `azimuth` (degrees).
- **Useful optional parameters:** `dataset` (defaults to `nsrdb`), `dc_ac_ratio`, `gcr` (ground coverage ratio for trackers), `inv_eff`, `albedo`, `bifaciality`, `timeframe` ("monthly" or "hourly"; we use monthly).
- **Response shape:**
  - `inputs.*` — echo of the parameters we sent.
  - `station_info` — `lat`, `lon`, `elev`, `tz`, `location`, `state` of the nearest NSRDB station.
  - `outputs.ac_annual` — annual AC kWh.
  - `outputs.ac_monthly` — 12-element array, AC kWh per month.
  - `outputs.dc_monthly` — 12-element array, DC kWh per month.
  - `outputs.poa_monthly` — plane-of-array irradiance, 12-element array (kWh/m²).
  - `outputs.solrad_monthly` — global horizontal irradiance, 12-element array.
  - `outputs.solrad_annual` — annual GHI.
  - `outputs.capacity_factor` — percentage.
  - `errors`, `warnings` — string arrays. Treat any present `errors` as a tool error.

---

## Project-relevant defaults

These live in `src/defaults.ts` and are applied by `solar_potential_for_acres` unless overridden:

| Parameter | Value | Rationale |
|---|---|---|
| Acres per MW DC | 8.0 | Industry rule of thumb for fixed-tilt utility-scale on flat ground at Utah pitch. Tracker projects can go to 5–6 acres/MW; we model the conservative case. |
| Module type | 0 (Standard) | Utility-scale on retired alfalfa won't pay the premium-module markup. |
| Array type | 0 (Fixed open rack) | Conservative. Real projects in Utah's irradiance lean toward 1-axis tracker (array_type=2), which boosts annual yield ~15–20%; the convenience tool exposes a `tracker: bool` flag to flip this. |
| Tilt | 25° | Year-round optimum for ~40°N latitude is ~0.6 × latitude. Cache Valley is 41.7°N. |
| Azimuth | 180° | South-facing. |
| Losses | 14.08% | NLR's published default; covers soiling, wiring, inverter, mismatch, availability. |
| DC/AC ratio | 1.2 | Standard utility-scale design point. |
| Inverter efficiency | 96% | Modern central inverter typical. |
| Default $/MWh | 35 | Approximate PacifiCorp Schedule 38 avoided cost. **Caveat in tool docstring: real PPA rates often higher (~$50–$80/MWh) but commercially negotiated.** |

---

## Tool surface

Two tools.

### 1. `pvwatts_run`

Faithful PVWatts v8 wrapper. Use this when the model wants to override defaults — e.g., compare fixed-tilt vs. tracker, model a roof system, change tilt for site-specific topography.

**Parameters:**
- `lat` (number, required): -90 to 90.
- `lon` (number, required): -180 to 180.
- `system_capacity_kw` (number, required): system size in kW DC. PVWatts supports 0.05 – 500,000.
- `module_type` (integer, optional, default `0`): 0 = standard, 1 = premium, 2 = thin film.
- `array_type` (integer, optional, default `0`): 0 = fixed open rack, 1 = fixed roof, 2 = 1-axis tracker, 3 = 1-axis backtracking, 4 = 2-axis tracker.
- `tilt` (number, optional, default `25`): degrees from horizontal.
- `azimuth` (number, optional, default `180`): degrees from north.
- `losses` (number, optional, default `14.08`): system losses as a percentage.
- `dc_ac_ratio` (number, optional, default `1.2`).
- `gcr` (number, optional, default `0.4`): ground coverage ratio. Ignored for non-tracker arrays.
- `inv_eff` (number, optional, default `96`): inverter efficiency percentage.
- `bifaciality` (number, optional): 0–1. Skip unless the model explicitly asks for bifacial.
- `dataset` (string, optional, default `"nsrdb"`): one of `nsrdb`, `tmy2`, `tmy3`, `intl`.

**Behavior:**
- Build the query string with the supplied parameters plus `api_key` from `env.NREL_API_KEY` and `timeframe=monthly`.
- GET `https://developer.nlr.gov/api/pvwatts/v8.json?...`.
- Surface `errors[]` from the response as tool errors. Surface `warnings[]` as a `warnings: []` field in the result (don't suppress).
- Cache key: SHA-1 of the canonical parameter set.

**Returns:**
```json
{
  "inputs": {
    "lat": 41.72,
    "lon": -111.83,
    "system_capacity_kw": 10000,
    "array_type": 0,
    "tilt": 25,
    "azimuth": 180,
    "module_type": 0,
    "losses": 14.08
  },
  "station": {
    "lat": 41.69,
    "lon": -111.85,
    "elev_m": 1370,
    "tz_offset": -7,
    "name": "WBAN_725115",
    "state": "UT"
  },
  "annual": {
    "ac_kwh": 22034000,
    "dc_kwh": 26280000,
    "capacity_factor_pct": 25.1,
    "ghi_kwh_per_m2": 1869,
    "poa_kwh_per_m2": 2110
  },
  "monthly": {
    "ac_kwh":  [1100000, 1340000, 1810000, 2010000, 2230000, 2370000, 2380000, 2230000, 1890000, 1530000, 1110000, 1030000],
    "ghi_kwh_per_m2": [82, 105, 152, 178, 213, 230, 226, 200, 161, 121, 84, 73],
    "poa_kwh_per_m2": [126, 150, 187, 199, 222, 235, 233, 219, 202, 169, 128, 113]
  },
  "warnings": []
}
```

(Numbers above are illustrative — Cache Valley reality should land within 5%.)

---

### 2. `solar_potential_for_acres`

Convenience wrapper: takes acreage and a centroid, applies project defaults, returns the numbers the conversation actually wants.

**Parameters:**
- `lat` (number, required).
- `lon` (number, required).
- `acres` (number, required): parcel acreage to allocate to solar.
- `tracker` (bool, optional, default `false`): if true, sets `array_type=3` (1-axis backtracking) and `gcr=0.35`. Bumps annual yield ~15–20%.
- `acres_per_mw_dc` (number, optional, default `8`): override the default density assumption.
- `price_per_mwh_usd` (number, optional, default `35`): used for the indicative revenue estimate.

**Behavior:**
- Compute `system_capacity_kw = acres / acres_per_mw_dc * 1000`.
- Call `pvwatts_run` internally with project defaults (or tracker overrides if `tracker=true`).
- Compute `annual_revenue_usd = ac_annual_mwh * price_per_mwh_usd`.
- Return a flatter, more interpretation-ready response.

**Returns:**
```json
{
  "inputs": {
    "lat": 41.72,
    "lon": -111.83,
    "acres": 80,
    "system_capacity_mw_dc": 10.0,
    "configuration": "fixed-tilt-25deg",
    "price_per_mwh_usd": 35
  },
  "annual": {
    "generation_mwh": 22034,
    "capacity_factor_pct": 25.1,
    "indicative_revenue_usd": 771190,
    "ghi_kwh_per_m2": 1869
  },
  "monthly_generation_mwh": [1100, 1340, 1810, 2010, 2230, 2370, 2380, 2230, 1890, 1530, 1110, 1030],
  "caveats": [
    "Revenue assumes flat $35/MWh wholesale (≈ PacifiCorp avoided cost). Real PPA terms are commercially negotiated — for utility-scale solar in Utah, $50–80/MWh is the commonly cited band; pass price_per_mwh_usd to test sensitivity.",
    "Acres/MW assumes flat ground at typical pitch. Real density is parcel-shape-dependent; expect 5–10% variation.",
    "Capacity factor includes the standard 14.08% losses default. Site-specific soiling and snow loss may differ in northern Utah."
  ]
}
```

The `caveats` array is an explicit honesty layer — it surfaces the assumptions in a place the model is forced to read before quoting numbers.

---

## Error handling

PVWatts returns HTTP 200 even on validation errors, with `errors[]` populated. The MCP must:

1. Treat any non-empty `errors[]` as a tool error (raise, don't return). Preserve the full error message — NLR's messages are clear and actionable.
2. Treat non-empty `warnings[]` as advisory. Pass through unchanged.
3. Treat HTTP 4xx (auth failure) and 5xx (NREL outage) as tool errors with informative messages. 401 specifically should say "NREL_API_KEY is invalid or unset — re-set via `wrangler secret put NREL_API_KEY`."
4. Surface rate-limit headers when remaining capacity drops below 100/hour. If exhausted (HTTP 429), wait, retry once, then fail with a message naming the reset time from `X-RateLimit-Reset`.

---

## Acceptance test

The MCP is ready to ship when this single call returns sane numbers:

```python
solar_potential_for_acres(
    lat=41.72,
    lon=-111.83,    # Cache Valley, Utah
    acres=80,
    tracker=False
)
```

**Expected output (within ~10%):**
- `system_capacity_mw_dc`: 10.0
- `annual.generation_mwh`: 21,000–24,000
- `annual.capacity_factor_pct`: 24–26
- `annual.ghi_kwh_per_m2`: 1,800–1,900
- `annual.indicative_revenue_usd`: ~$735K–$840K (at $35/MWh)
- `monthly_generation_mwh`: lowest values in Dec/Jan (~1,000), peak in Jun/Jul (~2,400)

If those land in range, the MCP is wired up. Then the natural follow-up is the **same call with `tracker=true`** — yield should jump to 25,000–28,000 MWh and capacity factor to ~28–30%, validating that the array-type knob is plumbed correctly.

---

## Composition with the UGRC MCP

The intended end-to-end flow (after both MCPs are deployed) for a per-parcel hero study:

```
1. ugrc-gis: query_layer(layer="parcels_lir",
                          where="COUNTY_NAME='CACHE' AND PROP_CLASS LIKE '%AGRIC%' AND PARCEL_ACRES BETWEEN 50 AND 200",
                          out_fields=["PARCEL_ID","PARCEL_ACRES","TOTAL_MKT_VALUE"],
                          return_geometry=true,
                          limit=20)
    → 20 candidate alfalfa parcels in Cache Valley with polygons.

2. ugrc-gis: query_layer(layer="wrlu",
                          geometry=<one parcel polygon>,
                          where="Description='Alfalfa' AND IRR_Method IN ('Sprinkler','Flood','Drip')")
    → confirm parcel is currently irrigated alfalfa, get exact irrigated acres.

3. (locally) compute parcel centroid from polygon.

4. pvwatts: solar_potential_for_acres(lat=<centroid_lat>,
                                      lon=<centroid_lon>,
                                      acres=<irrigated_acres>)
    → annual MWh, capacity factor, indicative revenue.

5. (compose) Combine with the alfalfa economics doc's $150–$300/acre net for the
   "what we're paying him not to do" baseline.

→ One row in the case-study table: parcel_id, acres, current ag revenue, projected
  solar revenue, payback period, MW size.
```

Repeat for 3–5 parcels across small / mid / large size tiers. That's the data that drives the infographic's hero-parcel callout.

---

## What's deliberately out of scope for v1

- **NSRDB direct access.** NLR exposes raw irradiance time series at `developer.nlr.gov/api/nsrdb/v2/...`. Not needed for v1 — PVWatts wraps NSRDB internally for the lookup we care about. Add as v2 if we ever need 8760 hourly profiles for time-of-day arbitrage modeling.
- **Multi-point batch.** PVWatts has no batch endpoint — the model loops. At ~100 ms per call and 1,000/hour rate limit, that's plenty for the project's needs (<100 parcels in any single run). Add a batch tool only if we exceed that.
- **System Advisor Model (SAM).** SAM is the heavyweight cousin of PVWatts — full hourly simulation, financial pro forma, weather-stochastic. Massive overkill for v1 and only available as a desktop app or a separate REST API. Hard pass.
- **Other NLR APIs.** Solar Resource Data, Utility Rates, Building Stock — interesting, not needed yet.
- **Real PPA pricing.** No public API; FERC filings exist but aren't structured. Deal with this as a manual research step when sizing the policy proposal.
