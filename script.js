/* ─── SCENARIOS ──────────────────────────────────────────────── */
const SCENARIOS = {
  bull: { g1: 30, g2: 20, tgr: 3.5, margin: 20, wacc: 9,  capex: 7,  tax: 18, dna: 4 },
  base: { g1: 15, g2: 10, tgr: 3.0, margin: 15, wacc: 10, capex: 8,  tax: 21, dna: 4 },
  bear: { g1:  5, g2:  3, tgr: 2.5, margin:  8, wacc: 13, capex: 7,  tax: 21, dna: 4 },
};

/* ─── PRICE SOURCES ──────────────────────────────────────────── */
const PRICE_SOURCES = [
  {
    name: 'Stooq',
    url:  'https://stooq.com/q/l/?s=tsla.us&f=sd2t2ohlcv&h&e=csv',
    parse: async (res) => {
      const text = await res.text();
      const rows = text.trim().split('\n');
      if (rows.length < 2) throw new Error('Empty CSV');
      const cols = rows[1].split(',');
      const price = parseFloat(cols[6]);
      if (!isFinite(price)) throw new Error('Non-numeric close: ' + cols[6]);
      return price;
    },
  },
  {
    name: 'Yahoo v8 (query1)',
    url:  'https://query1.finance.yahoo.com/v8/finance/chart/TSLA',
    parse: async (res) => {
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!price) throw new Error('Missing regularMarketPrice');
      return price;
    },
  },
  {
    name: 'Yahoo v8 (query2)',
    url:  'https://query2.finance.yahoo.com/v8/finance/chart/TSLA',
    parse: async (res) => {
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!price) throw new Error('Missing regularMarketPrice');
      return price;
    },
  },
];

/* ─── ERROR LOG (localStorage) ───────────────────────────────── */
function logFetchError({ source, phase, error, status, hint }) {
  try {
    const KEY = 'tsla_errors';
    const log = JSON.parse(localStorage.getItem(KEY) || '[]');
    log.unshift({ time: Date.now(), source, phase, error, status, hint });
    if (log.length > 50) log.length = 50;
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch (_) {}
}

/* ─── PRICE CACHE ────────────────────────────────────────────── */
const CACHE_KEY  = 'tsla_price_cache';
const CACHE_SECS = 8 * 3600;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && (Date.now() / 1000 - c.ts) < CACHE_SECS) return c;
  } catch (_) {}
  return null;
}

function writeCache(price, source) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ price, source, ts: Date.now() / 1000 }));
}

/* ─── UI HELPERS ─────────────────────────────────────────────── */
function setPriceStatus(text, cls) {
  const el = document.getElementById('price-status');
  el.textContent = text;
  el.className = 'price-badge ' + (cls || '');
}

function setSpinning(on) {
  document.getElementById('refresh-icon').style.animation = on ? 'spin 0.8s linear infinite' : '';
}

function fmt(n, decimals) {
  if (decimals === undefined) decimals = 1;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtB(n) {
  return '$' + fmt(n / 1e9, 1) + 'B';
}

/* ─── FETCH LIVE PRICE ───────────────────────────────────────── */
async function fetchLivePrice() {
  setSpinning(true);
  setPriceStatus('Fetching\u2026', '');

  for (const src of PRICE_SOURCES) {
    try {
      const res = await fetch(src.url);
      if (!res.ok) {
        logFetchError({ source: src.name, phase: 'http-error', error: res.statusText, status: res.status, hint: 'Non-2xx response' });
        continue;
      }
      const price = await src.parse(res);
      writeCache(price, src.name);
      document.getElementById('market-price').value = Math.round(price);
      setPriceStatus('Live \u00b7 ' + src.name, 'green');
      document.getElementById('price-timestamp').textContent = 'Updated ' + new Date().toLocaleTimeString();
      update();
      setSpinning(false);
      return;
    } catch (err) {
      const isNetwork = err instanceof TypeError;
      logFetchError({
        source: src.name,
        phase:  isNetwork ? 'network-or-cors' : 'parse-error',
        error:  err.message,
        hint:   isNetwork ? 'Likely CORS or offline' : 'Check parse logic',
      });
    }
  }

  const cached = readCache();
  if (cached) {
    document.getElementById('market-price').value = Math.round(cached.price);
    setPriceStatus('Cached \u00b7 ' + cached.source, 'amber');
    const age = Math.round((Date.now() / 1000 - cached.ts) / 3600);
    document.getElementById('price-timestamp').textContent = 'Cached ~' + age + 'h ago \u00b7 all live sources failed';
    update();
  } else {
    setPriceStatus('Offline', 'red');
    document.getElementById('price-timestamp').textContent = 'All sources failed \u2014 check Error Log';
  }
  setSpinning(false);
}

/* ─── GET FIXED INPUTS ───────────────────────────────────────── */
function getFixed() {
  return {
    baseRev: parseFloat(document.getElementById('base-rev').value)  || 100,
    netCash: parseFloat(document.getElementById('net-cash').value)  || 24,
    shares:  parseFloat(document.getElementById('shares').value)    || 3.2,
  };
}

/* ─── DCF CALCULATION ────────────────────────────────────────── */
function calcDCF(params, fixed) {
  const g1r        = params.g1    / 100;
  const g2r        = params.g2    / 100;
  const tgrR       = params.tgr   / 100;
  const waccR      = params.wacc  / 100;
  const capexR     = params.capex / 100;
  const taxR       = params.tax   / 100;
  const dnaR       = params.dna   / 100;
  const targetMargin = params.margin / 100;
  const startMargin  = 0.07;

  let rev = fixed.baseRev;
  let pvFCF = 0;
  var yr10FCF = 0, yr10FCFMargin = 0;

  for (let yr = 1; yr <= 10; yr++) {
    rev       = rev * (1 + (yr <= 5 ? g1r : g2r));
    const opMargin = startMargin + (targetMargin - startMargin) * (yr / 10);
    const nopat    = rev * opMargin * (1 - taxR);
    const da       = rev * dnaR;
    const capexAmt = rev * capexR;
    const fcf      = nopat + da - capexAmt;
    pvFCF         += fcf / Math.pow(1 + waccR, yr);
    if (yr === 10) { yr10FCF = fcf; yr10FCFMargin = fcf / rev; }
  }

  const tv     = (yr10FCF * (1 + tgrR)) / (waccR - tgrR);
  const pvTV   = tv / Math.pow(1 + waccR, 10);
  const ev     = pvFCF + pvTV;
  const equity = ev + fixed.netCash;
  const fairValue = (equity * 1e9) / (fixed.shares * 1e9);

  const rev2026  = fixed.baseRev * (1 + g1r);
  const ebit2026 = rev2026 * (startMargin + (targetMargin - startMargin) * 0.1);
  const evRev    = ev / rev2026;
  const evEbit   = ebit2026 > 0 ? ev / ebit2026 : null;
  const tvPct    = equity > 0 ? pvTV / equity : null;

  return { pvFCF, pvTV, ev, equity, fairValue, evRev, evEbit, tvPct, yr10FCFMargin };
}

/* ─── SCENARIO CARD PRICES ───────────────────────────────────── */
function updateScenarioPrices() {
  const fixed = getFixed();
  for (const key of ['bull', 'base', 'bear']) {
    const { fairValue } = calcDCF(SCENARIOS[key], fixed);
    const el = document.getElementById(key + '-price');
    if (el) el.textContent = '$' + fmt(fairValue, 0);
  }
}

/* ─── DETECT ACTIVE SCENARIO ─────────────────────────────────── */
function detectScenario() {
  const mapping = [
    ['growth1', 'g1'], ['growth2', 'g2'], ['tgr', 'tgr'], ['margin', 'margin'],
    ['wacc', 'wacc'], ['capex', 'capex'], ['taxrate', 'tax'], ['dna', 'dna'],
  ];
  for (const key of ['bull', 'base', 'bear']) {
    const s = SCENARIOS[key];
    const match = mapping.every(([id, k]) => parseFloat(document.getElementById(id).value) === s[k]);
    if (match) return key;
  }
  return 'custom';
}

/* ─── LOAD SCENARIO ──────────────────────────────────────────── */
function loadScenario(key) {
  const s = SCENARIOS[key];
  if (!s) return;
  const map = { growth1: s.g1, growth2: s.g2, tgr: s.tgr, margin: s.margin, wacc: s.wacc, capex: s.capex, taxrate: s.tax, dna: s.dna };
  for (const [id, val] of Object.entries(map)) {
    document.getElementById(id).value = val;
  }
  updateSliderLabels();
  update();
}

/* ─── SLIDER LABEL SYNC ──────────────────────────────────────── */
function updateSliderLabels() {
  const v = id => parseFloat(document.getElementById(id).value);
  document.getElementById('g1-val').textContent     = v('growth1') + '%';
  document.getElementById('g2-val').textContent     = v('growth2') + '%';
  document.getElementById('tgr-val').textContent    = v('tgr').toFixed(1) + '%';
  document.getElementById('margin-val').textContent = v('margin').toFixed(1) + '%';
  document.getElementById('capex-val').textContent  = v('capex').toFixed(1) + '%';
  document.getElementById('tax-val').textContent    = v('taxrate') + '%';
  document.getElementById('dna-val').textContent    = v('dna').toFixed(1) + '%';
  document.getElementById('wacc-val').textContent   = v('wacc').toFixed(1) + '%';
}

/* ─── MAIN UPDATE ────────────────────────────────────────────── */
function update() {
  updateSliderLabels();

  const v = id => parseFloat(document.getElementById(id).value);
  const params = {
    g1: v('growth1'), g2: v('growth2'), tgr: v('tgr'),
    margin: v('margin'), wacc: v('wacc'), capex: v('capex'),
    tax: v('taxrate'), dna: v('dna'),
  };
  const fixed = getFixed();
  const r = calcDCF(params, fixed);

  const marketPrice = parseFloat(document.getElementById('market-price').value) || 280;
  const upside = ((r.fairValue - marketPrice) / marketPrice) * 100;
  const upsideSign = upside >= 0 ? '+' : '';
  const isUp = upside >= 0;

  // Model outputs
  document.getElementById('out-price').textContent         = '$' + fmt(r.fairValue, 0);
  const upEl = document.getElementById('out-upside');
  upEl.textContent = upsideSign + fmt(upside, 1) + '% vs $' + fmt(marketPrice, 0) + ' market price';
  upEl.style.color = isUp ? 'var(--green)' : 'var(--red)';

  document.getElementById('out-pv-fcf').textContent        = fmtB(r.pvFCF);
  document.getElementById('out-pv-tv').textContent         = fmtB(r.pvTV);
  document.getElementById('out-ev').textContent            = fmtB(r.ev);
  document.getElementById('out-net-cash-disp').textContent = '$' + fixed.netCash.toFixed(1) + 'B';
  document.getElementById('out-equity').textContent        = fmtB(r.equity);

  document.getElementById('out-ev-rev').textContent    = r.evRev  != null ? fmt(r.evRev, 1)  + 'x' : '\u2014';
  document.getElementById('out-ev-ebit').textContent   = r.evEbit != null ? fmt(r.evEbit, 1) + 'x' : '\u2014';
  document.getElementById('out-tv-pct').textContent    = r.tvPct  != null ? fmt(r.tvPct * 100, 1) + '%' : '\u2014';
  document.getElementById('out-fcf-margin').textContent = fmt(r.yr10FCFMargin * 100, 1) + '%';

  const warn = document.getElementById('tv-warning');
  if (r.tvPct != null && r.tvPct > 0.8) warn.classList.remove('hidden');
  else warn.classList.add('hidden');

  // Hero
  document.getElementById('hero-price').textContent  = '$' + fmt(r.fairValue, 0);
  const heroUp = document.getElementById('hero-upside');
  heroUp.textContent = upsideSign + fmt(upside, 1) + '% vs market';
  heroUp.style.color = isUp ? 'var(--green)' : 'var(--red)';

  // Active badge + card states
  const active = detectScenario();
  const labels = { bull: 'Bull Case', base: 'Base Case', bear: 'Bear Case', custom: 'Custom' };
  document.getElementById('active-badge').textContent = labels[active] || 'Custom';

  for (const key of ['bull', 'base', 'bear']) {
    const card = document.getElementById('card-' + key);
    const cta  = card && card.querySelector('.scenario-cta');
    if (key === active) {
      card && card.classList.add('active');
      if (cta) { cta.textContent = 'Current assumptions'; cta.classList.add('active-cta'); }
    } else {
      card && card.classList.remove('active');
      if (cta) { cta.textContent = 'Load scenario \u2192'; cta.classList.remove('active-cta'); }
    }
  }

  updateScenarioPrices();
  updateChart(params, fixed);
  buildSensitivity(params, fixed);
}

/* ─── PROJECTION CHART ───────────────────────────────────────── */
var projChart = null;

function updateChart(params, fixed) {
  const startMargin  = 0.07;
  const targetMargin = params.margin / 100;
  const years = [], revs = [], fcfs = [];

  let rev = fixed.baseRev;
  for (let yr = 1; yr <= 10; yr++) {
    rev = rev * (1 + (yr <= 5 ? params.g1 / 100 : params.g2 / 100));
    const opMargin = startMargin + (targetMargin - startMargin) * (yr / 10);
    const nopat    = rev * opMargin * (1 - params.tax / 100);
    const da       = rev * params.dna / 100;
    const capexAmt = rev * params.capex / 100;
    years.push('Yr ' + yr);
    revs.push(parseFloat(rev.toFixed(1)));
    fcfs.push(parseFloat((nopat + da - capexAmt).toFixed(1)));
  }

  const ctx = document.getElementById('projection-chart').getContext('2d');
  if (projChart) projChart.destroy();

  projChart = new Chart(ctx, {
    data: {
      labels: years,
      datasets: [
        {
          type: 'bar',
          label: 'Revenue ($B)',
          data: revs,
          backgroundColor: 'rgba(227,25,55,0.25)',
          borderColor: '#e31937',
          borderWidth: 1.5,
          borderRadius: 4,
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: 'FCF ($B)',
          data: fcfs,
          borderColor: '#fff',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.35,
          fill: true,
          yAxisID: 'y',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#86868b', font: { family: 'system-ui', size: 12 } } },
        tooltip: {
          backgroundColor: '#1d1d1f',
          titleColor: '#f5f5f7',
          bodyColor: '#86868b',
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': $' + ctx.parsed.y.toFixed(1) + 'B' },
        },
      },
      scales: {
        x: { ticks: { color: '#6e6e73', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: {
          ticks: { color: '#6e6e73', font: { size: 11 }, callback: v => '$' + v + 'B' },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  });
}

/* ─── SENSITIVITY TABLE ──────────────────────────────────────── */
function buildSensitivity(params, fixed) {
  const waccVals = [7, 8, 9, 10, 11, 12, 13, 14];
  const g1Vals   = [5, 10, 15, 20, 25, 30];
  const mktPrice = parseFloat(document.getElementById('market-price').value) || 280;

  let html = '<table class="sens-table"><thead><tr><th>WACC \\ Growth</th>';
  for (const g of g1Vals) html += '<th>' + g + '%</th>';
  html += '</tr></thead><tbody>';

  for (const w of waccVals) {
    html += '<tr><td><b>' + w + '%</b></td>';
    for (const g of g1Vals) {
      const { fairValue } = calcDCF({ ...params, wacc: w, g1: g }, fixed);
      const upside = ((fairValue - mktPrice) / mktPrice) * 100;
      let cls = upside >= 30 ? 'sg3' : upside >= 15 ? 'sg2' : upside >= 0 ? 'sg1' : upside >= -15 ? 'sr1' : upside >= -30 ? 'sr2' : 'sr3';
      const highlight = (w === params.wacc && g === params.g1) ? ' active-cell' : '';
      html += '<td class="' + cls + highlight + '" title="' + (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% vs $' + mktPrice + '">$' + Math.round(fairValue) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('sensitivity-table').innerHTML = html;
}

/* ─── PEER MULTIPLES TABLE ───────────────────────────────────── */
const PEERS = [
  { name: 'Tesla',    ticker: 'TSLA',  mktCap: '1.08T', evRev: 10.8, evEbitda:  68, fwdPE: 158, revGrowth: '+10%', highlight: true },
  { name: 'Toyota',   ticker: 'TM',    mktCap: '242B',  evRev:  0.9, evEbitda:   9, fwdPE:  10, revGrowth: '+3%' },
  { name: 'BYD',      ticker: 'BYDDY', mktCap: '107B',  evRev:  0.5, evEbitda:   8, fwdPE:  14, revGrowth: '+20%' },
  { name: 'Ford',     ticker: 'F',     mktCap:  '42B',  evRev:  0.3, evEbitda:   4, fwdPE:   8, revGrowth: '+2%' },
  { name: 'GM',       ticker: 'GM',    mktCap:  '47B',  evRev:  0.3, evEbitda:   3, fwdPE:   5, revGrowth: '+3%' },
  { name: 'Rivian',   ticker: 'RIVN',  mktCap:  '14B',  evRev:  2.1, evEbitda: null,fwdPE: null,revGrowth: '+35%' },
  { name: 'Lucid',    ticker: 'LCID',  mktCap:   '7B',  evRev: 15.0, evEbitda: null,fwdPE: null,revGrowth: '+90%' },
  { name: 'Apple',    ticker: 'AAPL',  mktCap:  '3.4T', evRev:  8.1, evEbitda:  24, fwdPE:  28, revGrowth: '+6%' },
  { name: 'NVIDIA',   ticker: 'NVDA',  mktCap:  '2.7T', evRev: 19.8, evEbitda:  38, fwdPE:  32, revGrowth: '+95%' },
  { name: 'Alphabet', ticker: 'GOOGL', mktCap:  '2.0T', evRev:  6.3, evEbitda:  18, fwdPE:  20, revGrowth: '+12%' },
];

function buildPeers() {
  document.getElementById('peers-tbody').innerHTML = PEERS.map(p =>
    '<tr' + (p.highlight ? ' class="peer-highlight"' : '') + '>' +
    '<td><b>' + p.name + '</b> <span class="ticker-tag">' + p.ticker + '</span></td>' +
    '<td>' + p.mktCap + '</td>' +
    '<td>' + (p.evRev != null ? p.evRev + 'x' : '\u2014') + '</td>' +
    '<td>' + (p.evEbitda != null ? p.evEbitda + 'x' : 'NM') + '</td>' +
    '<td>' + (p.fwdPE != null ? p.fwdPE + 'x' : 'NM') + '</td>' +
    '<td>' + p.revGrowth + '</td>' +
    '</tr>'
  ).join('');
}

/* ─── SCROLL REVEAL ──────────────────────────────────────────── */
function initScrollReveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-up').forEach(el => io.observe(el));

  document.querySelectorAll('.animate-in').forEach((el, i) => {
    el.style.animationDelay = (i * 0.12) + 's';
    el.classList.add('visible');
  });
}

/* ─── INJECT STYLES ──────────────────────────────────────────── */
(function injectStyles() {
  const s = document.createElement('style');
  s.textContent = [
    '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
    '.sens-table{border-collapse:collapse;width:100%;font-size:13px}',
    '.sens-table th,.sens-table td{padding:8px 12px;text-align:center;border:1px solid #e8e8ed}',
    '.sens-table th{background:#f5f5f7;font-weight:600;color:#1d1d1f}',
    '.sens-table td:first-child{background:#f5f5f7;font-weight:600;color:#1d1d1f;text-align:left}',
    '.sg3{background:#1a7f37;color:#fff}',
    '.sg2{background:#2da44e;color:#fff}',
    '.sg1{background:#a8f5be;color:#1a7f37}',
    '.sr1{background:#ffd6d6;color:#9a0000}',
    '.sr2{background:#e31937;color:#fff}',
    '.sr3{background:#8b0000;color:#fff}',
    '.active-cell{outline:2.5px solid #1d1d1f;outline-offset:-2px;font-weight:700}',
    '.ticker-tag{font-size:11px;color:#86868b;font-weight:400;margin-left:4px}',
    '.peer-highlight td{color:#e31937!important;font-weight:600}',
    ':root{--green:#2da44e}',
  ].join('');
  document.head.appendChild(s);
})();

/* ─── EVENT WIRING ───────────────────────────────────────────── */
function wireEvents() {
  ['growth1','growth2','tgr','margin','capex','taxrate','dna','wacc'].forEach(id => {
    document.getElementById(id).addEventListener('input', update);
  });
  ['base-rev','net-cash','shares','market-price'].forEach(id => {
    document.getElementById(id).addEventListener('input', update);
  });
  document.getElementById('refresh-btn').addEventListener('click', fetchLivePrice);
}

/* ─── BOOT ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  initScrollReveal();
  wireEvents();
  buildPeers();
  loadScenario('base');

  const cached = readCache();
  if (cached) {
    document.getElementById('market-price').value = Math.round(cached.price);
    const age = Math.round((Date.now() / 1000 - cached.ts) / 60);
    setPriceStatus('Cached \u00b7 ' + cached.source, 'amber');
    document.getElementById('price-timestamp').textContent = 'Cached ' + age + 'm ago';
    update();
    if ((Date.now() / 1000 - cached.ts) > 3600) fetchLivePrice();
  } else {
    update();
    fetchLivePrice();
  }
});
