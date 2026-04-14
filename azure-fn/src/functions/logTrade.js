const { app } = require("@azure/functions");
const sql = require("mssql");

const sqlConfig = {
  server:   process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user:     process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options:  { encrypt: true, trustServerCertificate: false },
};

let pool = null;
async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(sqlConfig);
  return pool;
}

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
      context.log.error("SQL error:", err.message);
      pool = null; // reset pool on error so next call reconnects
      return { status: 500, body: `SQL error: ${err.message}` };
    }
  },
});
