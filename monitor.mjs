import crypto from 'node:crypto';

const pushplusToken = process.env.PUSHPLUS_TOKEN || '';
const pushplusTopic = process.env.PUSHPLUS_TOPIC || '';
const dryRun = process.argv.includes('--dry-run') || !pushplusToken;

const funds = [
  { code: '511880', market: 1, name: '银华日利ETF', category: '现金类', riskBand: 1 },
  { code: '511010', market: 1, name: '国泰上证5年期国债ETF', category: '国债类', riskBand: 2 },
  { code: '510300', market: 1, name: '沪深300ETF', category: '宽基指数', riskBand: 4 },
  { code: '518880', market: 1, name: '华安黄金ETF', category: '黄金类', riskBand: 4 },
  { code: '159915', market: 0, name: '创业板ETF', category: '成长指数', riskBand: 5 },
];
const products = {
  '现金类': ['天弘余额宝货币', '000198'],
  '国债类': ['易方达稳健收益债券A', '110007'],
  '宽基指数': ['景顺长城沪深300指数增强A', '000311'],
  '黄金类': ['易方达黄金ETF联接C', '002963'],
  '成长指数': ['天弘创业板ETF联接C', '001593'],
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'GoldFundMonitor/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function marketData() {
  const rows = await Promise.all(funds.map(async (fund) => {
    const symbol = `${fund.market ? 'sh' : 'sz'}${fund.code}`;
    const quoteText = String(await fetchText(`https://qt.gtimg.cn/q=${symbol}`));
    const quoted = quoteText.slice(quoteText.indexOf('"') + 1, quoteText.lastIndexOf('"')).split('~');
    const historyResult = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,60,qfq`);
    const history = historyResult.data?.[symbol]?.qfqday || historyResult.data?.[symbol]?.day || [];
    if (!quoted.length || !history.length) throw new Error(`No quote data for ${fund.code}`);
    return { ...fund, name: fund.name, price: Number(quoted[3]), changePercent: Number(quoted[32]), history: history.map((line) => { const [date, open, close, high, low] = line; return { date, close: Number(close), open: Number(open), high: Number(high), low: Number(low) }; }) };
  }));
  return { rows, updatedAt: new Date().toISOString() };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'GoldFundMonitor/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

function risk(row) {
  const closes = row.history.map((item) => item.close).filter(Number.isFinite).slice(-21);
  if (closes.length < 10) return { volatility: 99, drawdown: 99 };
  const returns = closes.slice(1).map((value, index) => value / closes[index] - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length) * Math.sqrt(252) * 100;
  let peak = closes[0], drawdown = 0;
  closes.forEach((value) => { peak = Math.max(peak, value); drawdown = Math.max(drawdown, (peak - value) / peak * 100); });
  return { volatility, drawdown };
}

function buildAdvice(row) {
  const r = risk(row);
  const recent = row.history.slice(-6).map((item) => item.close);
  const momentum5 = recent.length > 1 ? (recent.at(-1) / recent[0] - 1) * 100 : 0;
  const mean20 = row.history.slice(-20).reduce((sum, item) => sum + item.close, 0) / Math.max(1, row.history.slice(-20).length);
  const trend20 = (row.price / mean20 - 1) * 100;
  let score = 0;
  if (r.volatility >= 35) score -= 22; else if (r.volatility >= 25) score -= 12; else if (r.volatility >= 18) score -= 5; else score += 4;
  if (r.drawdown >= 12) score -= 12; else if (r.drawdown >= 7) score -= 6; else score += 3;
  if (momentum5 > 4) score -= 8; else if (momentum5 < -5) score -= 7; else if (momentum5 < -2) score -= 2; else score += 2;
  if (trend20 > 5) score -= 6; else if (trend20 < -5) score -= 5; else score += 2;
  const action = score < -18 ? 'pause' : score < 2 ? 'half' : 'full';
  const amount = action === 'full' ? 50 : action === 'half' ? 25 : 0;
  const product = products[row.category] || products['现金类'];
  return { action, amount, score, row, risk: r, momentum5, trend20, product };
}

function choose(rows) {
  return rows.map(buildAdvice).sort((a, b) => b.score - a.score || a.risk.volatility - b.risk.volatility)[0];
}

function formatAdvice(advice) {
  const action = advice.action === 'full' ? `今天可以买 ¥${advice.amount}` : advice.action === 'half' ? `今天只买 ¥${advice.amount}` : '今天暂停买入';
  const product = `${advice.product[0]}（${advice.product[1]}）`;
  return `<h2>50元基金观察员提醒</h2><p><strong>${action}</strong></p><p>今日优先方向：${product}</p><p>观察标的：${advice.row.name}（${advice.row.code}）· ${advice.row.category}</p><p>波动率约 ${advice.risk.volatility.toFixed(1)}%，近20日最大回撤约 ${advice.risk.drawdown.toFixed(1)}%，5日变化 ${advice.momentum5.toFixed(2)}%。</p><p>这只是公开行情规则分析，不会自动下单。若支付宝提示暂停买入，以支付宝平台提醒为准。</p>`;
}

async function push(content) {
  if (dryRun) { console.log(content.replace(/<[^>]+>/g, ' ')); return; }
  const response = await fetch('https://www.pushplus.plus/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pushplusToken, title: '50元基金观察员提醒', content, template: 'html', topic: pushplusTopic || undefined }) });
  if (!response.ok) throw new Error(`PushPlus HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 200) throw new Error(`PushPlus rejected: ${JSON.stringify(result)}`);
  console.log('PUSH_SENT');
}

try {
  const data = await marketData();
  const advice = choose(data.rows);
  const body = formatAdvice(advice);
  console.log(JSON.stringify({ updatedAt: data.updatedAt, action: advice.action, amount: advice.amount, product: advice.product, score: advice.score, dryRun }, null, 2));
  await push(body);
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
