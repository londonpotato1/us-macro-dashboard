// US Macro Dashboard — data aggregator (Cloudflare Worker)
// Fetches 5 keyless public sources, normalizes to one JSON, adds CORS + short cache.
// Each source degrades gracefully: on failure its field is null and an entry is pushed to `errors`.

const UA = { "User-Agent": "us-macro-dashboard/1.0" };

async function fetchTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 8000); // 한 소스가 hang해도 전체 블로킹 방지
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal, ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally {
    clearTimeout(id);
  }
}
const getJSON = (url, opts) => fetchTimeout(url, opts).then((r) => r.json());
const getText = (url) => fetchTimeout(url).then((r) => r.text());

// Treasury CSV: 정렬 가정에 의존하지 않고 날짜(MM/DD/YYYY) 최댓값 행 선택
function latestRow(lines) {
  const ts = (s) => {
    const [m, d, y] = s.split("/").map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  let best = null,
    bestTs = -1;
  for (const ln of lines.slice(1)) {
    if (!ln.trim()) continue;
    const cells = ln.split(",");
    const t = ts(cells[0]);
    if (t > bestTs) {
      bestTs = t;
      best = cells;
    }
  }
  return best;
}

// --- 국채금리: US Treasury 일일 par yield curve (CSV, 키 불필요) ---
export async function fetchYields() {
  const url =
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all" +
    "?type=daily_treasury_yield_curve&field_tdr_date_value=2026&_format=csv";
  const csv = await getText(url);
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const row = latestRow(lines).map((v) => v.trim());
  const col = (name) => {
    const i = header.indexOf(name);
    return i >= 0 ? parseFloat(row[i]) : null;
  };
  return {
    date: row[0],
    us2y: col("2 Yr"),
    us10y: col("10 Yr"),
    us30y: col("30 Yr"),
    source: "US Treasury (daily par yield)",
  };
}

// --- 코인: CoinGecko (키 불필요) ---
export async function fetchCrypto() {
  const d = await getJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
  );
  return {
    btc_usd: d.bitcoin?.usd ?? null,
    btc_24h_pct: d.bitcoin?.usd_24h_change ?? null,
    eth_usd: d.ethereum?.usd ?? null,
    eth_24h_pct: d.ethereum?.usd_24h_change ?? null,
    source: "CoinGecko",
  };
}

// --- 주가지수 + 유가: stooq (CSV, 키 불필요) ---
// stooq /q/l/ 는 콤마 배치를 지원하지 않음(한 행에 뭉개짐) → 심볼별 개별 병렬 호출.
async function stooqClose(sym) {
  try {
    const csv = await getText(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`);
    const row = csv.trim().split("\n")[1].split(","); // Symbol,Date,Time,O,H,L,Close,Vol
    const close = parseFloat(row[6]);
    return { close: isNaN(close) ? null : close, date: row[1] };
  } catch {
    return { close: null, date: null };
  }
}
export async function fetchStocksOil() {
  const syms = { spx: "^spx", ndx: "^ndq", dji: "^dji", wti: "cl.f", brent: "cb.f" };
  const entries = await Promise.all(
    Object.entries(syms).map(async ([k, s]) => [k, await stooqClose(s)])
  );
  const m = Object.fromEntries(entries);
  return {
    spx: m.spx.close,
    ndx: m.ndx.close,
    dji: m.dji.close,
    wti: m.wti.close,
    brent: m.brent.close,
    asof: m.spx.date || m.wti.date || null,
    source: "stooq",
  };
}

// --- Fed 인하 확률: Polymarket gamma API (키 불필요) ---
export async function fetchFed() {
  const ev = await getJSON(
    "https://gamma-api.polymarket.com/events?slug=how-many-fed-rate-cuts-in-2026"
  );
  const markets = ev?.[0]?.markets ?? [];
  const byOutcome = {};
  for (const m of markets) {
    let yes = null;
    try {
      const prices = JSON.parse(m.outcomePrices);
      yes = parseFloat(prices[0]); // [0] = "Yes"
    } catch {
      /* skip malformed */
    }
    // groupItemTitle 예: "0 (0 bps)", "1 (25 bps)" → 선행 정수를 키로
    const num = (m.groupItemTitle ?? "").trim().match(/^\d+/)?.[0];
    if (num != null && yes != null) byOutcome[num] = yes;
  }
  return {
    title: ev?.[0]?.title ?? "How many Fed rate cuts in 2026?",
    zero_cuts_prob: byOutcome["0"] ?? null,
    outcomes: byOutcome,
    source: "Polymarket",
  };
}

export async function aggregate() {
  const tasks = {
    yields: fetchYields(),
    crypto: fetchCrypto(),
    stocks_oil: fetchStocksOil(),
    fed: fetchFed(),
  };
  const out = { updated: new Date().toISOString(), errors: [] };
  const results = await Promise.allSettled(Object.values(tasks));
  Object.keys(tasks).forEach((key, i) => {
    const r = results[i];
    if (r.status === "fulfilled") out[key] = r.value;
    else {
      out[key] = null;
      out.errors.push({ source: key, message: String(r.reason?.message || r.reason) });
    }
  });
  return out;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const data = await aggregate();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        ...CORS,
      },
    });
  },
};
