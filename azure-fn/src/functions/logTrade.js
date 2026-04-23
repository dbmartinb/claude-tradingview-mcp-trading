const { app } = require("@azure/functions");
const sql = require("mssql");

const sqlConfig = {
  server:   process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user:     process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options:  { encrypt: true, trustServerCertificate: false },
};

// Azure SQL serverless auto-pauses after inactivity and takes 30-90s to wake.
// Retry with backoff until the database responds.
const WAKE_RETRIES = 10;
const WAKE_DELAY_MS = 10000; // 10s between retries = up to 100s total

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPauseError(err) {
  const msg = err.message || "";
  return (
    msg.includes("not currently available") ||
    msg.includes("is paused") ||
    msg.includes("40613") ||
    msg.includes("40197") ||
    msg.includes("timeout") ||
    err.code === "ETIMEOUT" ||
    err.code === "ESOCKET"
  );
}

let pool = null;
async function getPool() {
  if (pool) return pool;
  for (let attempt = 1; attempt <= WAKE_RETRIES; attempt++) {
    try {
      pool = await sql.connect(sqlConfig);
      return pool;
    } catch (err) {
      pool = null;
      if (attempt < WAKE_RETRIES && isPauseError(err)) {
        console.log(`  DB waking up (attempt ${attempt}/${WAKE_RETRIES}) — retrying in ${WAKE_DELAY_MS / 1000}s...`);
        await sleep(WAKE_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) + "%" : "—";
}

function timeAgo(dt) {
  if (!dt) return "Never";
  const ms = Date.now() - new Date(dt).getTime();
  if (ms < 60000) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function getReadiness(stratMap, overall) {
  const NAMES = { vwap_scalp: "VWAP Scalp", heikin_ashi: "Heikin Ashi", orb: "Opening Range" };
  const assessments = Object.keys(NAMES).map((key) => {
    const s = stratMap[key];
    if (!s || !s.total_30d) return { key, name: NAMES[key], badge: "NO DATA", color: "var(--mu)", passRate: 0, msg: "No signals in last 30 days." };
    const passRate = s.placed_30d / s.total_30d;
    const avg      = s.total_30d / 30;
    if (avg >= 3)         return { key, name: NAMES[key], badge: "HOT",    color: "var(--green)",  passRate, msg: `${Math.round(avg)}/day avg · ${pct(s.placed_30d, s.total_30d)} pass rate.` };
    if (passRate >= 0.35) return { key, name: NAMES[key], badge: "STRONG", color: "var(--blue)",   passRate, msg: `${pct(s.placed_30d, s.total_30d)} pass rate — high quality signals.` };
    if (s.total_30d >= 5) return { key, name: NAMES[key], badge: "ACTIVE", color: "var(--blue)",   passRate, msg: `${s.total_30d} signals / 30d · ${pct(s.placed_30d, s.total_30d)} pass rate.` };
    return                       { key, name: NAMES[key], badge: "QUIET",  color: "var(--mu)",    passRate, msg: `${s.total_30d} signal${s.total_30d === 1 ? "" : "s"} in 30 days — conditions rarely aligned.` };
  });

  const totalPaper = overall.total_placed || 0;
  const daysActive = overall.days_active  || 0;
  const best = assessments.filter(a => a.passRate > 0).sort((a, b) => b.passRate - a.passRate)[0];

  const criteria = [
    { met: totalPaper >= 50, text: `${totalPaper} paper trades logged`,        note: totalPaper < 50  ? `${50 - totalPaper} more needed`   : "" },
    { met: daysActive >= 14, text: `${daysActive} days of data`,               note: daysActive < 14  ? `${14 - daysActive} more needed`   : "" },
    { met: !!(best && best.passRate >= 0.2),
      text: best ? `Best: ${best.name} — ${Math.round(best.passRate * 100)}% pass rate` : "No strategy has 20%+ pass rate yet",
      note: !best || best.passRate < 0.2 ? "20% threshold needed" : "" },
  ];

  const metCount = criteria.filter(c => c.met).length;
  let goLiveMsg;
  if (metCount === criteria.length) {
    goLiveMsg = `All criteria met. Consider activating <strong>${best ? best.name : "your top strategy"}</strong> for live trading — start with a small position ($10–20 per trade) and monitor for 1–2 weeks before scaling.`;
  } else if (metCount >= 2) {
    goLiveMsg = "Almost there — keep paper trading until all three criteria are green.";
  } else {
    goLiveMsg = "Continue paper trading. More history is needed before going live reliably.";
  }

  return { assessments, criteria, metCount, goLiveMsg };
}

function buildDashboardHtml(stratMap, symbols, overall) {
  const mode     = (overall.recent_live || 0) > 0 ? "LIVE" : "PAPER";
  const exchange = esc(overall.exchange_name || "—");
  const rd       = getReadiness(stratMap, overall);
  const now      = new Date().toUTCString().slice(5, 22);

  const STRATS = [
    { key: "vwap_scalp",  name: "VWAP Scalp",    desc: "VWAP · RSI(3) · EMA(8)", color: "#5ba4f5" },
    { key: "heikin_ashi", name: "Heikin Ashi",   desc: "Smoothed candle trend",            color: "#b87bff" },
    { key: "orb",         name: "Opening Range", desc: "Session breakout",                 color: "#f5b84a" },
  ];

  const stratCards = STRATS.map((cfg) => {
    const s         = stratMap[cfg.key] || {};
    const pass30    = s.total_30d ? Math.round((s.placed_30d / s.total_30d) * 100) : 0;
    const last      = timeAgo(s.last_signal);
    const dirTotal  = (s.long_30d || 0) + (s.short_30d || 0);
    const longPct   = dirTotal ? Math.round(((s.long_30d || 0) / dirTotal) * 100) : 50;

    const wins = [
      { id: "1d",  label: "24H", total: s.total_1d  || 0, placed: s.placed_1d  || 0 },
      { id: "7d",  label: "7D",  total: s.total_7d  || 0, placed: s.placed_7d  || 0 },
      { id: "30d", label: "30D", total: s.total_30d || 0, placed: s.placed_30d || 0 },
    ];

    const tabs   = wins.map((w, i) => `<button class="tab${i === 0 ? " on" : ""}" data-w="${w.id}" onclick="sw(this,'${w.id}')">${w.label}</button>`).join("");
    const panels = wins.map((w, i) => `
      <div class="panel" data-panel="${w.id}"${i > 0 ? ' style="display:none"' : ""}>
        <div class="prow">
          <div class="pstat"><div class="pn">${w.total}</div><div class="pl">signals</div></div>
          <div class="pstat"><div class="pn" style="color:${cfg.color}">${w.placed}</div><div class="pl">placed</div></div>
          <div class="pstat"><div class="pn">${pct(w.placed, w.total)}</div><div class="pl">pass rate</div></div>
        </div>
      </div>`).join("");

    return `
<div class="card sc">
  <div class="sc-top" style="border-left:3px solid ${cfg.color};padding-left:12px">
    <div>
      <div class="sc-name" style="color:${cfg.color}">${esc(cfg.name)}</div>
      <div class="sc-desc">${esc(cfg.desc)}</div>
    </div>
    <div class="sc-last">Last signal<br><b style="color:${cfg.color}">${esc(last)}</b></div>
  </div>
  <div class="tabs">${tabs}</div>
  ${panels}
  <div class="brow"><span class="bl">Pass rate 30d</span><span style="color:${cfg.color}">${pass30}%</span></div>
  <div class="bar"><div class="bf" style="width:${pass30}%;background:${cfg.color}"></div></div>
  <div class="dir">
    <span class="dg">▲ ${s.long_30d || 0}</span>
    <div class="db"><div class="dbf" style="width:${longPct}%;background:${cfg.color}"></div></div>
    <span class="dr">${s.short_30d || 0} ▼</span>
  </div>
</div>`;
  }).join("\n");

  const symRows = symbols.length === 0
    ? `<tr><td colspan="5" class="empty">No trades yet — run the bot to populate data</td></tr>`
    : symbols.map((sym) => {
        const bias  = sym.longs > sym.shorts ? "▲ Long" : sym.shorts > sym.longs ? "▼ Short" : "— Neutral";
        const biasC = sym.longs > sym.shorts ? "var(--green)" : sym.shorts > sym.longs ? "var(--red)" : "var(--mu)";
        return `<tr>
          <td class="mono fw">${esc(sym.symbol)}</td>
          <td class="r mono">${sym.total}</td>
          <td class="r mono" style="color:var(--green)">${sym.placed}</td>
          <td class="r mono">${pct(sym.placed, sym.total)}</td>
          <td style="color:${biasC}">${bias}</td>
        </tr>`;
      }).join("");

  const BADGE_COLOR = { HOT: "var(--green)", STRONG: "var(--blue)", ACTIVE: "var(--blue)", QUIET: "var(--mu)", "NO DATA": "var(--mu)" };
  const BADGE_BG    = { HOT: "rgba(45,212,160,.12)", STRONG: "rgba(91,164,245,.12)", ACTIVE: "rgba(91,164,245,.08)", QUIET: "rgba(86,106,141,.1)", "NO DATA": "rgba(86,106,141,.1)" };

  const recRows = rd.assessments.map((a) => `
    <div class="rec-row">
      <span class="rbadge" style="color:${BADGE_COLOR[a.badge]};background:${BADGE_BG[a.badge]}">${a.badge}</span>
      <span class="rname">${esc(a.name)}</span>
      <span class="rmsg">${esc(a.msg)}</span>
    </div>`).join("");

  const critRows = rd.criteria.map((c) => `
    <div class="crit">
      <span style="color:${c.met ? "var(--green)" : "var(--mu)"}">${c.met ? "✓" : "○"}</span>
      <span style="color:${c.met ? "var(--text)" : "var(--mu)"}">${esc(c.text)}</span>
      ${c.note ? `<span class="cnote">${esc(c.note)}</span>` : ""}
    </div>`).join("");

  const glColor  = rd.metCount === rd.criteria.length ? "var(--green)" : rd.metCount >= 2 ? "var(--yellow)" : "var(--mu)";
  const modeHtml = mode === "LIVE"
    ? `<span class="mbadge live">● LIVE</span>`
    : `<span class="mbadge paper">◎ PAPER</span>`;

  const since = overall.first_trade ? "since " + new Date(overall.first_trade).toISOString().slice(0, 10) : "no data yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlackPear Bot · Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#07090f;--surf:#0c1220;--card:#101929;--bd:#1a2540;--bd2:#243051;--text:#dde4ef;--mu:#566a8d;--green:#2dd4a0;--red:#f06a6a;--blue:#5ba4f5;--yellow:#f5b84a}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;min-height:100vh}
.mono{font-family:'SF Mono',Monaco,'Fira Code',monospace}.fw{font-weight:700}.r{text-align:right}.mu{color:var(--mu)}
header{background:var(--surf);border-bottom:1px solid var(--bd);padding:15px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.hname{font-family:'SF Mono',Monaco,monospace;font-size:17px;font-weight:700;letter-spacing:.08em;color:#fff;display:flex;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);flex-shrink:0}
.hright{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mbadge{padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.1em}
.mbadge.paper{background:rgba(245,184,74,.12);color:var(--yellow);border:1px solid rgba(245,184,74,.25)}
.mbadge.live{background:rgba(240,106,106,.12);color:var(--red);border:1px solid rgba(240,106,106,.25)}
.exbadge{padding:3px 10px;border-radius:20px;font-size:11px;background:rgba(91,164,245,.1);color:var(--blue);border:1px solid rgba(91,164,245,.2)}
.upd{color:var(--mu);font-size:12px}
.rbtn{color:var(--mu);font-size:12px;text-decoration:none;padding:3px 12px;border:1px solid var(--bd2);border-radius:20px;transition:color .15s,border-color .15s}
.rbtn:hover{color:var(--text);border-color:var(--mu)}
main{max-width:1180px;margin:0 auto;padding:24px 20px}
.stitle{font-size:11px;font-weight:700;color:var(--mu);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
.ov{display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap}
.ovc{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px 20px;flex:1;min-width:130px}
.ovl{font-size:11px;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.ovv{font-size:30px;font-weight:700;color:#fff;line-height:1}
.ovs{font-size:11px;color:var(--mu);margin-top:5px}
.scgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:18px;transition:border-color .2s}
.card:hover{border-color:var(--bd2)}
.sc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.sc-name{font-size:15px;font-weight:700;margin-bottom:3px}.sc-desc{font-size:12px;color:var(--mu)}
.sc-last{text-align:right;font-size:11px;color:var(--mu);line-height:1.8}
.tabs{display:flex;gap:3px;background:var(--bg);border-radius:8px;padding:3px;width:fit-content;margin-bottom:12px}
.tab{background:none;border:none;color:var(--mu);font-size:12px;font-weight:600;padding:4px 14px;border-radius:6px;cursor:pointer;transition:all .15s}
.tab.on{background:var(--surf);color:#fff}
.prow{display:flex;gap:8px}
.pstat{flex:1;text-align:center;padding:10px 6px;background:var(--surf);border-radius:8px}
.pn{font-size:22px;font-weight:700;color:#fff;line-height:1.1}
.pl{font-size:10px;color:var(--mu);margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
.brow{display:flex;justify-content:space-between;font-size:12px;color:var(--mu);font-weight:600;margin-top:14px;margin-bottom:5px}
.bar{height:5px;background:var(--bd);border-radius:3px;overflow:hidden}
.bf{height:100%;border-radius:3px}
.dir{display:flex;align-items:center;gap:8px;margin-top:8px}
.dg{font-size:11px;color:var(--green);font-weight:600;white-space:nowrap}
.dr{font-size:11px;color:var(--red);font-weight:600;white-space:nowrap}
.db{flex:1;height:4px;background:var(--red);border-radius:2px;overflow:hidden}
.dbf{height:100%;border-radius:2px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{text-align:left;font-size:11px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;padding:8px 12px;border-bottom:1px solid var(--bd)}
td{padding:9px 12px;border-bottom:1px solid var(--bd)}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.empty{text-align:center;color:var(--mu);padding:28px !important}
.rcard{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:22px;margin-bottom:24px}
.rsec{font-size:11px;font-weight:700;color:var(--mu);text-transform:uppercase;letter-spacing:.08em;margin:20px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--bd)}
.rsec:first-child{margin-top:0}
.rec-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--bd);flex-wrap:wrap}
.rec-row:last-child{border-bottom:none}
.rbadge{font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;white-space:nowrap}
.rname{font-weight:600;font-size:13px;min-width:120px}
.rmsg{color:var(--mu);font-size:12px;flex:1}
.crit{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)}
.crit:last-child{border-bottom:none}
.cnote{margin-left:auto;font-size:11px;color:var(--mu);font-style:italic;white-space:nowrap}
.glbox{margin-top:16px;padding:14px 18px;border-radius:8px;background:rgba(255,255,255,.03);font-size:13px;line-height:1.7}
footer{text-align:center;padding:20px;color:var(--mu);font-size:12px;border-top:1px solid var(--bd)}
@media(max-width:620px){.ov{flex-direction:column}.scgrid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="hname"><span class="dot"></span>BLACKPEAR BOT</div>
  <div class="hright">
    ${modeHtml}
    <span class="exbadge">${exchange}</span>
    <span class="upd">${now} UTC</span>
    <a class="rbtn" href="?">&#8635; Refresh</a>
  </div>
</header>

<main>

<div class="ov">
  <div class="ovc"><div class="ovl">Total Signals</div><div class="ovv">${overall.total_signals || 0}</div><div class="ovs">last 30 days</div></div>
  <div class="ovc"><div class="ovl">Trades Placed</div><div class="ovv">${overall.total_placed || 0}</div><div class="ovs">paper trades</div></div>
  <div class="ovc"><div class="ovl">Days Active</div><div class="ovv">${overall.days_active || 0}</div><div class="ovs">${since}</div></div>
  <div class="ovc"><div class="ovl">Symbols</div><div class="ovv">${overall.symbols_active || 0}</div><div class="ovs">trading pairs</div></div>
</div>

<div class="stitle">Strategy Performance</div>
<div class="scgrid">
${stratCards}
</div>

<div class="stitle">Top Symbols &middot; 30 Day</div>
<table>
  <thead>
    <tr>
      <th>Symbol</th>
      <th style="text-align:right">Signals</th>
      <th style="text-align:right">Placed</th>
      <th style="text-align:right">Pass Rate</th>
      <th>Bias</th>
    </tr>
  </thead>
  <tbody>${symRows}</tbody>
</table>

<div class="stitle">Recommendations</div>
<div class="rcard">
  <div class="rsec">Strategy Assessment</div>
  ${recRows}
  <div class="rsec">Go-Live Readiness</div>
  ${critRows}
  <div class="glbox" style="border:1px solid ${glColor};color:${glColor}">${rd.goLiveMsg}</div>
</div>

</main>
<footer>BlackPear Trading Bot &nbsp;&middot;&nbsp; <a class="rbtn" href="?">&#8635; Refresh</a></footer>

<script>
function sw(btn, w) {
  var card = btn.closest('.sc');
  var panels = card.querySelectorAll('[data-panel]');
  for (var i = 0; i < panels.length; i++) {
    panels[i].style.display = panels[i].getAttribute('data-panel') === w ? '' : 'none';
  }
  var tabs = card.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].className = 'tab' + (tabs[i].getAttribute('data-w') === w ? ' on' : '');
  }
}
</script>
</body>
</html>`;
}

app.http("getDashboard", {
  methods: ["GET"],
  authLevel: "function",
  route: "dashboard",
  handler: async (request, context) => {
    try {
      const db = await getPool();

      const [statsRes, symRes, overallRes] = await Promise.all([
        db.request().query(`
          SELECT strategy,
            COUNT(*) AS total_30d,
            SUM(CASE WHEN mode IN ('PAPER','LIVE') THEN 1 ELSE 0 END)    AS placed_30d,
            SUM(CASE WHEN mode = 'BLOCKED'         THEN 1 ELSE 0 END)    AS blocked_30d,
            SUM(CASE WHEN signal = 'long'          THEN 1 ELSE 0 END)    AS long_30d,
            SUM(CASE WHEN signal = 'short'         THEN 1 ELSE 0 END)    AS short_30d,
            SUM(CASE WHEN trade_date >= CAST(DATEADD(DAY,-7,GETUTCDATE()) AS DATE)                               THEN 1 ELSE 0 END) AS total_7d,
            SUM(CASE WHEN trade_date >= CAST(DATEADD(DAY,-7,GETUTCDATE()) AS DATE) AND mode IN('PAPER','LIVE')  THEN 1 ELSE 0 END) AS placed_7d,
            SUM(CASE WHEN trade_date >= CAST(DATEADD(DAY,-1,GETUTCDATE()) AS DATE)                               THEN 1 ELSE 0 END) AS total_1d,
            SUM(CASE WHEN trade_date >= CAST(DATEADD(DAY,-1,GETUTCDATE()) AS DATE) AND mode IN('PAPER','LIVE')  THEN 1 ELSE 0 END) AS placed_1d,
            MAX(CONVERT(DATETIME, CONVERT(VARCHAR(10),trade_date,120)+' '+CONVERT(VARCHAR(8),trade_time,108))) AS last_signal
          FROM trades
          WHERE trade_date >= CAST(DATEADD(DAY,-30,GETUTCDATE()) AS DATE)
          GROUP BY strategy
        `),
        db.request().query(`
          SELECT TOP 5 symbol,
            COUNT(*) AS total,
            SUM(CASE WHEN mode IN ('PAPER','LIVE') THEN 1 ELSE 0 END) AS placed,
            SUM(CASE WHEN signal = 'long'  THEN 1 ELSE 0 END) AS longs,
            SUM(CASE WHEN signal = 'short' THEN 1 ELSE 0 END) AS shorts
          FROM trades
          WHERE trade_date >= CAST(DATEADD(DAY,-30,GETUTCDATE()) AS DATE)
          GROUP BY symbol
          ORDER BY placed DESC, total DESC
        `),
        db.request().query(`
          SELECT
            COUNT(DISTINCT trade_date)                                                                           AS days_active,
            SUM(CASE WHEN mode IN ('PAPER','LIVE') THEN 1 ELSE 0 END)                                           AS total_placed,
            COUNT(*)                                                                                             AS total_signals,
            COUNT(DISTINCT symbol)                                                                               AS symbols_active,
            MIN(trade_date)                                                                                      AS first_trade,
            SUM(CASE WHEN mode='LIVE' AND trade_date>=CAST(DATEADD(DAY,-7,GETUTCDATE()) AS DATE) THEN 1 ELSE 0 END) AS recent_live,
            (SELECT TOP 1 exchange FROM trades ORDER BY trade_date DESC, trade_time DESC)                        AS exchange_name
          FROM trades
        `),
      ]);

      const stratMap = {};
      for (const row of statsRes.recordset) stratMap[row.strategy] = row;

      return {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: buildDashboardHtml(stratMap, symRes.recordset, overallRes.recordset[0] || {}),
      };
    } catch (err) {
      context.error("Dashboard error:", err.message);
      return {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: `<!DOCTYPE html><html><body style="background:#07090f;color:#f06a6a;font-family:monospace;padding:40px"><h2>Dashboard Unavailable</h2><p style="margin-top:16px;color:#566a8d">The database may be waking up — refresh in 30 seconds.</p></body></html>`,
      };
    }
  },
});

app.http("logTrade", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    // Validate content type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return { status: 400, body: "Expected application/json" };
    }

    let trades;
    try {
      const body = await request.json();
      // Accept either a single trade object or an array
      trades = Array.isArray(body) ? body : [body];
    } catch {
      return { status: 400, body: "Invalid JSON body" };
    }

    if (trades.length === 0) {
      return { status: 400, body: "No trades provided" };
    }

    try {
      const db = await getPool();
      let inserted = 0;

      for (const t of trades) {
        const now = new Date(t.timestamp);
        const exchangeName = t.exchange || "Unknown";

        let side = null, quantity = null, totalUSD = null, fee = null,
            netAmount = null, orderId = null, mode, notes;

        if (!t.allPass) {
          const failed = (t.conditions || [])
            .filter((c) => !c.pass)
            .map((c) => c.label)
            .join("; ");
          mode = "BLOCKED"; orderId = "BLOCKED";
          notes = `Failed: ${failed}`;
        } else if (t.paperTrading) {
          side      = t.signal === "long" ? "BUY" : "SELL";
          quantity  = t.tradeSize / t.price;
          totalUSD  = t.tradeSize;
          fee       = t.tradeSize * 0.001;
          netAmount = t.tradeSize - fee;
          orderId   = t.orderId || null;
          mode = "PAPER"; notes = "All conditions met";
        } else {
          side      = t.signal === "long" ? "BUY" : "SELL";
          quantity  = t.tradeSize / t.price;
          totalUSD  = t.tradeSize;
          fee       = t.tradeSize * 0.001;
          netAmount = t.tradeSize - fee;
          orderId   = t.orderId || null;
          mode = "LIVE";
          notes = t.error ? `Error: ${t.error}` : "All conditions met";
        }

        await db.request()
          .input("trade_date",  sql.Date,           now)
          .input("trade_time",  sql.Time,            now)
          .input("exchange",    sql.NVarChar(50),    exchangeName)
          .input("symbol",      sql.NVarChar(20),    t.symbol)
          .input("strategy",    sql.NVarChar(50),    t.strategy)
          .input("signal",      sql.NVarChar(10),    t.signal)
          .input("side",        sql.NVarChar(10),    side)
          .input("quantity",    sql.Decimal(18, 8),  quantity)
          .input("price",       sql.Decimal(18, 2),  t.price)
          .input("total_usd",   sql.Decimal(18, 2),  totalUSD)
          .input("fee_est",     sql.Decimal(18, 4),  fee)
          .input("net_amount",  sql.Decimal(18, 2),  netAmount)
          .input("order_id",    sql.NVarChar(100),   orderId)
          .input("mode",        sql.NVarChar(20),    mode)
          .input("notes",       sql.NVarChar(500),   notes)
          .query(`
            INSERT INTO trades
              (trade_date, trade_time, exchange, symbol, strategy, signal,
               side, quantity, price, total_usd, fee_est, net_amount,
               order_id, mode, notes)
            VALUES
              (@trade_date, @trade_time, @exchange, @symbol, @strategy, @signal,
               @side, @quantity, @price, @total_usd, @fee_est, @net_amount,
               @order_id, @mode, @notes)
          `);

        inserted++;
      }

      context.log(`Inserted ${inserted} trade(s).`);
      return { status: 200, body: JSON.stringify({ inserted }) };

    } catch (err) {
      context.error("SQL error:", err.message);
      pool = null; // reset pool on error so next call reconnects
      return { status: 500, body: "Internal error — trade not logged" };
    }
  },
});
