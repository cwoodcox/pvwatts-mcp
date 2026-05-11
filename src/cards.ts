// HTML templates for mcp-ui resources returned alongside JSON tool output.
// Pure inline-styled HTML + SVG — no JS, no external CSS — so the markup
// renders identically inside any sandboxed iframe.

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${formatInt(n)}`;
}

export interface SolarCardInput {
  lat: number;
  lon: number;
  acres: number;
  system_capacity_mw_dc: number;
  configuration: string;
  price_per_mwh_usd: number;
  annual_generation_mwh: number;
  capacity_factor_pct: number;
  indicative_revenue_usd: number;
  ghi_kwh_per_m2: number;
  caveats: readonly string[];
}

export function solarPotentialCard(d: SolarCardInput): string {
  const stats = [
    { label: "System size", value: `${d.system_capacity_mw_dc.toFixed(1)} MW DC` },
    { label: "Annual generation", value: `${formatInt(d.annual_generation_mwh)} MWh` },
    { label: "Capacity factor", value: `${d.capacity_factor_pct.toFixed(1)}%` },
    { label: `Revenue @ $${d.price_per_mwh_usd}/MWh`, value: formatUSD(d.indicative_revenue_usd) },
  ];
  const statHtml = stats
    .map(
      (s) => `
      <div style="flex:1 1 140px;min-width:140px;padding:14px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:10px">
        <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;font-weight:600">${escapeHtml(s.label)}</div>
        <div style="margin-top:6px;font-size:22px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums">${escapeHtml(s.value)}</div>
      </div>`,
    )
    .join("");

  const caveatHtml = d.caveats
    .map((c) => `<li style="margin:6px 0;line-height:1.45">${escapeHtml(c)}</li>`)
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f8fafc">
  <div style="max-width:680px;margin:0 auto">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#ca8a04;font-weight:700">Solar Potential</div>
        <div style="margin-top:2px;font-size:18px;font-weight:700">${formatInt(d.acres)} acres · ${escapeHtml(d.configuration)}</div>
      </div>
      <div style="font-size:12px;color:#64748b;font-variant-numeric:tabular-nums">
        ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)} · GHI ${formatInt(d.ghi_kwh_per_m2)} kWh/m²
      </div>
    </div>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">${statHtml}</div>
    <div style="margin-top:16px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px">
      <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#92400e;font-weight:700;margin-bottom:4px">Caveats</div>
      <ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:#451a03">${caveatHtml}</ul>
    </div>
  </div>
</body></html>`;
}

export interface MonthlyChartInput {
  lat: number;
  lon: number;
  monthly_generation_mwh: number[]; // length 12
  unit: "MWh"; // expand if we ever return kWh
}

export function monthlyGenerationCard(d: MonthlyChartInput): string {
  const values = d.monthly_generation_mwh.slice(0, 12);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const peakIdx = values.indexOf(Math.max(...values));
  const troughIdx = values.indexOf(Math.min(...values));

  // SVG layout: 12 bars, 40px wide column, 6px gutter, 200px chart height.
  const colW = 40;
  const gap = 8;
  const chartH = 200;
  const labelBand = 26;
  const valueBand = 18;
  const padX = 16;
  const innerW = values.length * colW + (values.length - 1) * gap;
  const totalW = innerW + padX * 2;
  const totalH = chartH + labelBand + valueBand + 24;

  const bars = values
    .map((v, i) => {
      const h = (v / max) * chartH;
      const x = padX + i * (colW + gap);
      const y = chartH + valueBand - h + 12;
      const isPeak = i === peakIdx;
      const isTrough = i === troughIdx;
      const fill = isPeak ? "#ca8a04" : isTrough ? "#cbd5e1" : "#facc15";
      return `
        <text x="${x + colW / 2}" y="${y - 4}" text-anchor="middle" font-size="10" fill="#475569" font-family="-apple-system,sans-serif" font-weight="${isPeak ? 700 : 500}">${formatInt(v)}</text>
        <rect x="${x}" y="${y}" width="${colW}" height="${h}" rx="3" fill="${fill}"/>
        <text x="${x + colW / 2}" y="${chartH + valueBand + 28}" text-anchor="middle" font-size="11" fill="#64748b" font-family="-apple-system,sans-serif">${MONTH_LABELS[i]}</text>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f8fafc">
  <div style="max-width:${totalW + 40}px;margin:0 auto">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      <div>
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#ca8a04;font-weight:700">Monthly generation</div>
        <div style="margin-top:2px;font-size:16px;font-weight:700">${formatInt(total)} MWh total · peak ${MONTH_LABELS[peakIdx]} · trough ${MONTH_LABELS[troughIdx]}</div>
      </div>
      <div style="font-size:12px;color:#64748b;font-variant-numeric:tabular-nums">${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}</div>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;overflow-x:auto">
      <svg viewBox="0 0 ${totalW} ${totalH}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly generation in MWh">
        <line x1="${padX}" y1="${chartH + valueBand + 12}" x2="${totalW - padX}" y2="${chartH + valueBand + 12}" stroke="#e2e8f0" stroke-width="1"/>
        ${bars}
      </svg>
      <div style="margin-top:4px;font-size:11px;color:#94a3b8;text-align:right">Values in MWh</div>
    </div>
  </div>
</body></html>`;
}
