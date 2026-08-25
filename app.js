/* 
   app.js  –  VOYX Dashboard
   Data is loaded from Supabase orders and filtered by selected report date.
    */

/* ── STATE ─*/
let currentData   = null;   // dashboard payload for active report date
let currentDate   = '';     // active report_date string (YYYY-MM-DD)
let rawOrders     = [];     // full orders for CSV download
let rawUsers      = [];     // agents list
let availableRange = { minDate: null, maxDate: null };
let loadTimer     = null;

/* Chart instances */
const charts = {};

/* Avatar colours (cycles through agents) */
const PALETTE = [
  '#f97316','#6366f1','#10b981','#a855f7',
  '#06b6d4','#ef4444','#f59e0b','#ec4899',
  '#84cc16','#14b8a6'
];

/* ── UTILITIES ─ */

/** Format number as Indian ₹ shorthand */
function fmt(n) {
  if (!n && n !== 0) return '₹ –';
  n = +n;
  if (n >= 1e7)  return '₹' + (n/1e7).toFixed(2)  + ' Cr';
  if (n >= 1e5)  return '₹' + (n/1e5).toFixed(2)  + ' L';
  if (n >= 1000) return '₹' + (n/1000).toFixed(1) + 'K';
  return '₹' + n.toFixed(0);
}

/** Full Indian formatted ₹ */
function fmtFull(n) {
  if (!n && n !== 0) return '–';
  return '₹' + (+n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/** Count with sign */
function signed(n) {
  if (!n && n !== 0) return '–';
  return n > 0 ? '+' + n : String(n);
}

/** Percentage change */
function pctChange(current, prev) {
  if (!prev) return null;
  return ((current - prev) / prev * 100).toFixed(1);
}

/** Month name from number */
function monthName(m) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] || m;
}

/** Show toast notification */
function showToast(msg, duration = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

/** Set loading/ok/error status in topbar */
function setStatus(state, label) {
  const dot   = document.getElementById('status-dot');
  const lbl   = document.getElementById('status-label');
  dot.className = 'status-dot ' + state;
  lbl.textContent = label;
}

/** Destroy a chart if it exists */
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

/* ── SIDEBAR / TAB HANDLING ─── */
function toggleSidebar() {
  /*document.getElementById('sidebar').classList.toggle('open');*/
   const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('visible');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

function switchTab(tab, el) {
  document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  el.classList.add('active');

  // Resize charts that are in other tabs when switched to
  if (window.innerWidth <= 700) {
    closeSidebar();
  } 
  if (tab === 'market' && currentData) {
    renderMonthlyTrendChart();
  }
  return false;
}

/* ── DATE HANDLING ────────────────────────────────────────────── */
function onDateChange(val) {
  if (!val) return;
  currentDate = val;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => loadDashboard(), 250);
}

function applyDatePickerRange(minDate, maxDate) {
  const dateInput = document.getElementById('report-date');
  if (!dateInput || !minDate || !maxDate) return;

  dateInput.min = minDate;
  dateInput.max = maxDate;
  availableRange = { minDate, maxDate };

  if (!dateInput.value || cmpDate(dateInput.value, minDate) < 0 || cmpDate(dateInput.value, maxDate) > 0) {
    dateInput.value = maxDate;
    currentDate = maxDate;
  }
}

/* ── MASTER LOAD ──────────────────────────────────────────────── */
async function loadDashboard() {
  const dateInput = document.getElementById('report-date');
  const date = dateInput.value;
  if (!date) { showToast('⚠️ Please select a report date'); return; }

  currentDate = date;

  // Show loading state
  setStatus('loading', 'Loading…');
  document.getElementById('btn-load').classList.add('loading');
  document.getElementById('btn-load').innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px"></span> Loading…`;
  clearAllDisplays();

  try {
    const payload = await fetchDashboard(date);

    if (payload.empty) {
      currentData = null;
      showEmptyDashboard(payload.reason || 'No data for this date');
      setStatus('err', 'No data');
      showToast('⚠️ ' + (payload.reason || 'No data for this date'), 4500);
      return;
    }

    currentData = payload;
    rawOrders = await fetchAllOrders();
    rawUsers = await fetchAllUsers();

    renderKPICards(payload.kpi_cards);
    renderDailyChart(payload.daily_metrics);
    renderMonthlyChart(payload.monthly_metrics);
    renderLeaderboard(payload.leaderboard_metrics, 'lb-tbody');
    renderLeaderboard(payload.leaderboard_metrics, 'lb-full-tbody');
    renderAgentCards(payload.leaderboard_metrics);
    renderMarketSummary(payload);

    const d = new Date(date + 'T00:00:00');
    const dateStr = d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
    document.getElementById('lb-date-label').textContent = `Report: ${dateStr}`;
    document.getElementById('lb-tab-sub').textContent   = `MTD sales as of ${dateStr}`;
    document.getElementById('agent-cards-sub').textContent = `Performance as of ${dateStr}`;
    document.getElementById('market-sub').textContent   = `Monthly & daily overview as of ${dateStr}`;

    setStatus('ok', `Loaded — ${dateStr}`);
    showToast(`✅ Dashboard loaded for ${dateStr}`);

  } catch (err) {
    console.error(err);
    setStatus('err', 'Error loading');
    showToast('❌ ' + err.message, 5000);
  } finally {
    document.getElementById('btn-load').classList.remove('loading');
    document.getElementById('btn-load').innerHTML = `<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>Load`;
  }
}

/** Reset all table bodies to skeleton while loading */
function clearAllDisplays() {
  ['lb-tbody','lb-full-tbody'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<tr><td colspan="7" class="loading-cell"><span class="spinner"></span> Loading…</td></tr>`;
  });
  const grid = document.getElementById('agent-cards-grid');
  if (grid) grid.innerHTML = `<div class="loading-cell" style="grid-column:1/-1;padding:40px"><span class="spinner"></span> Loading…</div>`;
  const daily = document.getElementById('daily-table-body');
  if (daily) daily.innerHTML = `<tr><td colspan="4" class="loading-cell"><span class="spinner"></span> Loading…</td></tr>`;
}

/** Clear dashboard UI when selected date has no data */
function showEmptyDashboard(message) {
  destroyChart('daily');
  destroyChart('monthly');
  destroyChart('monthlyTrend');

  const zero = '0';
  const dash = '₹ –';
  document.getElementById('kpi-today-sales').textContent = zero;
  document.getElementById('kpi-today-rev').textContent = dash;
  document.getElementById('kpi-mtd-sales').textContent = zero;
  document.getElementById('kpi-mtd-rev').textContent = dash;
  document.getElementById('kpi-pmsd-sales').textContent = zero;
  document.getElementById('kpi-pmsd-rev').textContent = dash;
  document.getElementById('kpi-pm-sales').textContent = zero;
  document.getElementById('kpi-pm-rev').textContent = dash;

  ['ms-growth-pct','ms-best-day-cnt','ms-avg-daily','ms-mtd-rev-big'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '–';
  });
  ['ms-growth-label','ms-best-day-date','ms-avg-rev','ms-pm-rev-small'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '–';
  });

  ['lb-tbody','lb-full-tbody'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<tr><td colspan="7" class="loading-cell">${message}</td></tr>`;
  });

  const grid = document.getElementById('agent-cards-grid');
  if (grid) {
    grid.innerHTML = `<div class="loading-cell" style="grid-column:1/-1;padding:40px">${message}</div>`;
  }

  const daily = document.getElementById('daily-table-body');
  if (daily) daily.innerHTML = `<tr><td colspan="4" class="loading-cell">${message}</td></tr>`;
}

/* ══════════════════════════════════════════════════════════════
   KPI CARDS — Matches SQL: TODAY, MTD, PMSD, PM
   ══════════════════════════════════════════════════════════════ */
function renderKPICards(kpi) {
  if (!kpi) return;

  // Today
  document.getElementById('kpi-today-sales').textContent = (kpi.TODAY_SALES ?? 0).toLocaleString();
  document.getElementById('kpi-today-rev').textContent   = fmt(kpi.TODAY_REVENUE);

  // MTD
  document.getElementById('kpi-mtd-sales').textContent  = (kpi.mtd_sales ?? 0).toLocaleString();
  document.getElementById('kpi-mtd-rev').textContent     = fmt(kpi.MTD_REVENUE);

  // Prev Month Same Day
  document.getElementById('kpi-pmsd-sales').textContent  = (kpi.PMSD_SALES ?? 0).toLocaleString();
  document.getElementById('kpi-pmsd-rev').textContent    = fmt(kpi.PMSD_REVENUE);

  // Prev Month Full
  document.getElementById('kpi-pm-sales').textContent   = (kpi.PM_SALES ?? 0).toLocaleString();
  document.getElementById('kpi-pm-rev').textContent      = fmt(kpi.PM_REVENUE);
}

/* ══════════════════════════════════════════════════════════════
   DAILY CHART — from daily_metrics
   Fields: order_date, no_of_sales, total_revenue
   ══════════════════════════════════════════════════════════════ */
function renderDailyChart(daily) {
  if (!daily || !daily.length) {
    destroyChart('daily');
    return;
  }
  destroyChart('daily');

  const sorted   = [...daily].sort((a,b) => a.order_date.localeCompare(b.order_date));
  const labels   = sorted.map(d => {
    const dt = new Date(d.order_date + 'T00:00:00');
    return dt.getDate() + '/' + (dt.getMonth()+1);
  });
  const counts   = sorted.map(d => d.no_of_sales);
  const revenues = sorted.map(d => d.total_revenue || 0);

  const ctx = document.getElementById('dailyChart').getContext('2d');

  charts.daily = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Orders',
          data: counts,
          borderColor: '#f97316',
          backgroundColor: 'rgba(249,115,22,0.07)',
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#f97316',
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Revenue (₹)',
          data: revenues,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.05)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          pointBackgroundColor: '#6366f1',
          tension: 0.4,
          fill: true,
          yAxisID: 'y2'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,12,20,0.95)',
          borderColor: 'rgba(249,115,22,0.25)',
          borderWidth: 1,
          titleColor: '#e8eef8',
          bodyColor: '#8899b4',
          padding: 12,
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === 1)
                return `  Revenue: ₹${(+ctx.parsed.y).toLocaleString('en-IN',{maximumFractionDigits:0})}`;
              return `  Orders: ${ctx.parsed.y}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6a', font: { size: 11 }, maxTicksLimit: 14 }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6a', font: { size: 11 } },
          title: { display: true, text: 'Orders', color: '#3d4f6a', font: { size: 10 } }
        },
        y2: {
          position: 'right',
          grid: { display: false },
          ticks: {
            color: '#3d4f6a', font: { size: 11 },
            callback: v => '₹' + (v / 1000).toFixed(0) + 'K'
          },
          title: { display: true, text: 'Revenue', color: '#3d4f6a', font: { size: 10 } }
        }
      }
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   MONTHLY CHART — from monthly_metrics
   Fields: year, month, no_of_sales
   ══════════════════════════════════════════════════════════════ */
function renderMonthlyChart(monthly) {
  if (!monthly || !monthly.length) {
    destroyChart('monthly');
    return;
  }
  destroyChart('monthly');

  const sorted = [...monthly].sort((a,b) => {
    if (+a.year !== +b.year) return +a.year - +b.year;
    return +a.month - +b.month;
  });

  const labels = sorted.map(m => `${monthName(m.month)} '${String(m.year).slice(2)}`);
  const data   = sorted.map(m => m.no_of_sales);

  // Gradient colours from indigo → orange across months
  const bgColors = sorted.map((_,i) => {
    const t = sorted.length > 1 ? i / (sorted.length - 1) : 0;
    const r = Math.round(99  + (249-99)*t);
    const g = Math.round(102 + (115-102)*t);
    const b = Math.round(241 + (22-241)*t);
    return `rgba(${r},${g},${b},0.75)`;
  });

  const ctx = document.getElementById('monthlyChart').getContext('2d');

  charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Orders',
        data,
        backgroundColor: bgColors,
        borderRadius: 7,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,12,20,0.95)',
          borderColor: 'rgba(99,102,241,0.25)',
          borderWidth: 1,
          titleColor: '#e8eef8',
          bodyColor: '#8899b4',
          padding: 12,
          callbacks: { label: c => `  ${c.parsed.y} orders` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color:'#3d4f6a', font:{size:11} } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color:'#3d4f6a', font:{size:11} } }
      }
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   LEADERBOARD TABLE
   Fields: sales_representative, today_sales, today_revenue,
           mtd_sales, mtd_revenue
   ══════════════════════════════════════════════════════════════ */
function renderLeaderboard(leaderboard, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!leaderboard || !leaderboard.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">No data available</td></tr>`;
    return;
  }

  // Sort by MTD sales descending
  const sorted = [...leaderboard].sort((a,b) => (b.mtd_sales||0) - (a.mtd_sales||0));
  const totalMtd = sorted.reduce((s,a) => s + (a.mtd_sales||0), 0);

  tbody.innerHTML = sorted.map((agent, idx) => {
    const rank     = idx + 1;
    const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '';
    const name     = (agent.sales_representative || '–').trim();
    const initials = name.charAt(0).toUpperCase();
    const color    = PALETTE[idx % PALETTE.length];
    const todaySales = agent.today_sales ?? 0;
    const todayRev   = agent.today_revenue ?? 0;
    const mtdSales   = agent.mtd_sales ?? 0;
    const mtdRev     = agent.mtd_revenue ?? 0;
    const share      = totalMtd > 0 ? Math.round((mtdSales/totalMtd)*100) : 0;

    return `<tr>
      <td><span class="rank-badge ${rankClass}">${rank}</span></td>
      <td>
        <div class="agent-cell">
          <div class="agent-avatar" style="background:${color}">${initials}</div>
          <span style="font-weight:500">${name}</span>
        </div>
      </td>
      <td><span class="num-badge">${todaySales}</span></td>
      <td>${todayRev ? fmtFull(todayRev) : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td><strong>${mtdSales}</strong></td>
      <td>${fmtFull(mtdRev)}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar">
            <div class="progress-fill" style="width:${share}%"></div>
          </div>
          <span class="pct-label">${share}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/** Filter leaderboard rows by agent name */
function filterLeaderboard(inputId, tbodyId) {
  const query = document.getElementById(inputId).value.toLowerCase();
  const rows  = document.querySelectorAll(`#${tbodyId} tr`);
  rows.forEach(row => {
    const name = row.querySelector('.agent-cell span')?.textContent?.toLowerCase() || '';
    row.style.display = name.includes(query) ? '' : 'none';
  });
}

/* ══════════════════════════════════════════════════════════════
   AGENT CARDS
   ══════════════════════════════════════════════════════════════ */
function renderAgentCards(leaderboard) {
  const grid = document.getElementById('agent-cards-grid');
  if (!leaderboard || !leaderboard.length) {
    grid.innerHTML = `<div class="loading-cell" style="grid-column:1/-1;padding:40px">No agent data</div>`;
    return;
  }

  const sorted  = [...leaderboard].sort((a,b) => (b.mtd_sales||0) - (a.mtd_sales||0));
  const maxMtd  = sorted[0]?.mtd_sales || 1;
  const rankEmojis = ['🥇','🥈','🥉'];

  grid.innerHTML = sorted.map((agent, idx) => {
    const name     = (agent.sales_representative || '–').trim();
    const initials = name.charAt(0).toUpperCase();
    const color    = PALETTE[idx % PALETTE.length];
    const rank     = idx + 1;
    const todaySales = agent.today_sales ?? 0;
    const todayRev   = agent.today_revenue ?? 0;
    const mtdSales   = agent.mtd_sales ?? 0;
    const mtdRev     = agent.mtd_revenue ?? 0;
    const pct        = Math.round((mtdSales / maxMtd) * 100);
    const avgOrder   = mtdSales > 0 ? (mtdRev / mtdSales) : 0;

    return `<div class="agent-card" style="--card-color:${color}">
      <div style="position:absolute;top:0;left:0;right:0;height:2px;background:${color};border-radius:14px 14px 0 0;opacity:0.8"></div>
      <div class="agent-card-hdr">
        <div class="agent-card-av" style="background:${color}">${initials}</div>
        <div class="agent-card-info">
          <div class="agent-card-name">${name} ${rankEmojis[idx] || ''}</div>
          <div class="agent-card-id">Rank #${rank}</div>
        </div>
        <div class="agent-card-rank">#${rank}</div>
      </div>

      <div class="agent-stats">
        <div class="agent-stat">
          <div class="agent-stat-val" style="color:${color}">${todaySales}</div>
          <div class="agent-stat-lbl">Today</div>
        </div>
        <div class="agent-stat">
          <div class="agent-stat-val">${mtdSales}</div>
          <div class="agent-stat-lbl">MTD</div>
        </div>
        <div class="agent-stat">
          <div class="agent-stat-val" style="font-size:13px">${fmt(mtdRev)}</div>
          <div class="agent-stat-lbl">MTD Rev</div>
        </div>
        <div class="agent-stat">
          <div class="agent-stat-val" style="font-size:13px">${fmt(avgOrder)}</div>
          <div class="agent-stat-lbl">Avg/Sale</div>
        </div>
      </div>

      <div class="agent-card-progress">
        <div class="agent-prog-lbl">
          <span>Share vs Top Agent</span>
          <span style="color:${color};font-weight:600">${pct}%</span>
        </div>
        <div class="progress-bar" style="height:7px;">
          <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        ${todayRev > 0 ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">Today Revenue: <span style="color:var(--text-secondary)">${fmtFull(todayRev)}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   MARKET SUMMARY TAB
   ══════════════════════════════════════════════════════════════ */
function renderMarketSummary(data) {
  const kpi    = data.kpi_cards      || {};
  const daily  = data.daily_metrics  || [];
  const monthly= data.monthly_metrics|| [];

  // Growth: MTD vs PMSD
  const growth = pctChange(kpi.mtd_sales, kpi.PMSD_SALES);
  const growthEl = document.getElementById('ms-growth-pct');
  if (growth !== null) {
    growthEl.textContent = (growth >= 0 ? '+' : '') + growth + '%';
    growthEl.style.color = growth >= 0 ? '#34d399' : '#ef4444';
  }
  document.getElementById('ms-growth-label').textContent =
    `MTD ${kpi.mtd_sales || 0} vs PMSD ${kpi.PMSD_SALES || 0} orders`;

  // Best day in current month
  if (daily.length) {
    const best = daily.reduce((a,b) => (a.no_of_sales > b.no_of_sales ? a : b));
    document.getElementById('ms-best-day-cnt').textContent  = best.no_of_sales;
    const dt = new Date(best.order_date + 'T00:00:00');
    document.getElementById('ms-best-day-date').textContent =
      dt.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  }

  // Avg daily
  if (daily.length) {
    const totalOrders = daily.reduce((s,d) => s + d.no_of_sales, 0);
    const totalRev    = daily.reduce((s,d) => s + (d.total_revenue||0), 0);
    document.getElementById('ms-avg-daily').textContent  = Math.round(totalOrders / daily.length);
    document.getElementById('ms-avg-rev').textContent    = fmt(totalRev / daily.length) + ' avg/day';
  }

  // MTD Revenue card
  document.getElementById('ms-mtd-rev-big').textContent  = fmt(kpi.MTD_REVENUE);
  document.getElementById('ms-pm-rev-small').textContent  = `PM: ${fmt(kpi.PM_REVENUE)}`;

  // Daily table
  renderDailyTable(daily);

  // Monthly trend chart
  renderMonthlyTrendChart();
}

function renderDailyTable(daily) {
  const tbody = document.getElementById('daily-table-body');
  if (!daily || !daily.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">No daily data</td></tr>`;
    return;
  }

  const sorted = [...daily].sort((a,b) => b.order_date.localeCompare(a.order_date));

  tbody.innerHTML = sorted.map(d => {
    const dt   = new Date(d.order_date + 'T00:00:00');
    const date = dt.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' });
    const avg  = d.no_of_sales > 0 ? ((d.total_revenue||0) / d.no_of_sales) : 0;
    return `<tr>
      <td>${date}</td>
      <td><strong>${d.no_of_sales}</strong></td>
      <td>${fmtFull(d.total_revenue || 0)}</td>
      <td>${fmtFull(avg)}</td>
    </tr>`;
  }).join('');
}

function renderMonthlyTrendChart() {
  if (!currentData) return;
  const monthly = currentData.monthly_metrics || [];
  if (!monthly.length) return;
  destroyChart('monthlyTrend');

  const sorted = [...monthly].sort((a,b) => {
    if (+a.year !== +b.year) return +a.year - +b.year;
    return +a.month - +b.month;
  });

  const labels   = sorted.map(m => `${monthName(m.month)} '${String(m.year).slice(2)}`);
  const data     = sorted.map(m => m.no_of_sales);
  const maxVal   = Math.max(...data);

  const ctx = document.getElementById('monthlyTrendChart').getContext('2d');

  // Create gradient
  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(249,115,22,0.35)');
  grad.addColorStop(1, 'rgba(249,115,22,0.02)');

  charts.monthlyTrend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Monthly Orders',
        data,
        borderColor: '#f97316',
        backgroundColor: grad,
        borderWidth: 3,
        pointRadius: 6,
        pointHoverRadius: 9,
        pointBackgroundColor: sorted.map((m,i) => data[i] === maxVal ? '#fbbf24' : '#f97316'),
        pointBorderColor: '#080c14',
        pointBorderWidth: 2,
        tension: 0.35,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,12,20,0.95)',
          borderColor: 'rgba(249,115,22,0.25)',
          borderWidth: 1,
          titleColor: '#e8eef8',
          bodyColor: '#8899b4',
          padding: 14,
          callbacks: {
            label: c => `  ${c.parsed.y} orders`,
            afterLabel: c => {
              const idx = c.dataIndex;
              if (idx === 0) return '';
              const prev = data[idx - 1];
              const curr = data[idx];
              const chg  = pctChange(curr, prev);
              return chg !== null
                ? `  ${chg >= 0 ? '↑' : '↓'} ${Math.abs(chg)}% vs prev month`
                : '';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6a', font: { size: 12 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6a', font: { size: 12 } },
          beginAtZero: true
        }
      }
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   CSV DOWNLOAD
   ══════════════════════════════════════════════════════════════ */
async function fetchUsersForCSV() {
  try {
    rawUsers = await fetchAllUsers(true);
  } catch (e) {
    console.warn('Users fetch failed:', e);
  }
}

function downloadCSV() {
  // If no raw orders, use leaderboard data as fallback
  if (!currentData) { showToast('⚠️ Load data first'); return; }

  // Build CSV from leaderboard_metrics (always available)
  const lb = currentData.leaderboard_metrics || [];
  const rows = [
    ['Agent', 'Today Sales', 'Today Revenue (₹)', 'MTD Sales', 'MTD Revenue (₹)']
  ];
  lb.forEach(a => {
    rows.push([
      (a.sales_representative||'').trim(),
      a.today_sales ?? 0,
      +(a.today_revenue ?? 0).toFixed(2),
      a.mtd_sales ?? 0,
      +(a.mtd_revenue ?? 0).toFixed(2)
    ]);
  });

  // Also add daily summary
  rows.push([]);
  rows.push(['Date', 'Orders', 'Revenue (₹)']);
  (currentData.daily_metrics || [])
    .sort((a,b) => a.order_date.localeCompare(b.order_date))
    .forEach(d => rows.push([d.order_date, d.no_of_sales, +(d.total_revenue||0).toFixed(2)]));

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `voyx_report_${currentDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ CSV downloaded!');
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const dateInput = document.getElementById('report-date');

  try {
    const orders = await fetchAllOrders();
    rawUsers = await fetchAllUsers();
    rawOrders = orders;
    const { minDate, maxDate } = getDateAvailability(orders);
    applyDatePickerRange(minDate, maxDate);
    rawOrders = orders;
  } catch (err) {
    console.error(err);
    setStatus('err', 'Connection error');
    showToast('❌ Could not load orders: ' + err.message, 5000);
    return;
  }

  currentDate = dateInput.value;
  loadDashboard();
});
