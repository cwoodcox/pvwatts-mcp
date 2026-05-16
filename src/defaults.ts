// Project-relevant defaults for the Watts for Water / Cache Valley sizing.
// See spec.md § "Project-relevant defaults" for rationale on each value.

export const DEFAULTS = {
  // Faithful PVWatts parameter defaults applied by pvwatts_run when caller omits them.
  module_type: 0, // 0 = standard, 1 = premium, 2 = thin film
  array_type: 0, // 0 = fixed open rack
  tilt: 25, // ~0.6 × latitude for 41.7°N Cache Valley
  azimuth: 180, // south-facing
  losses: 14.08, // NLR published default
  dc_ac_ratio: 1.2,
  gcr: 0.4, // ignored for non-tracker arrays
  inv_eff: 96,
  dataset: "nsrdb" as const,

  // Convenience-tool-only knobs.
  acres_per_mw_dc: 8.0, // fixed-tilt utility-scale on flat ground at Utah pitch
  price_per_mwh_usd: 35, // approx PacifiCorp Schedule 38 avoided cost

  // Tracker overrides applied when solar_potential_for_acres receives tracker=true.
  tracker_array_type: 3, // 1-axis backtracking
  tracker_gcr: 0.35,
} as const;

export const CAVEATS = [
  "Revenue assumes flat $35/MWh wholesale (≈ PacifiCorp avoided cost). Real PPA terms are commercially negotiated — for utility-scale solar in Utah, $50–80/MWh is the commonly cited band; pass price_per_mwh_usd to test sensitivity.",
  "Acres/MW assumes flat ground at typical pitch. Real density is parcel-shape-dependent; expect 5–10% variation.",
  "Capacity factor includes the standard 14.08% losses default. Site-specific soiling and snow loss may differ in northern Utah.",
] as const;
