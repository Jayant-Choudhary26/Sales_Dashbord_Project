// config.js
// Note: SUPABASE_URL and SUPABASE_KEY are now loaded globally from env.js

const BASE_URL = `${SUPABASE_URL}/rest/v1`;

const HEADERS = {
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
  'Accept':        'application/json'
};

let cachedOrders = null;
let cachedUsers  = null;
let userNameById = new Map();

/** Extract YYYY-MM-DD from an order row */
function orderDateStr(order) {
  const raw = order.order_date_time || order.order_date || '';
  return String(raw).slice(0, 10);
}

/** Revenue for a single order row */
function orderRevenue(order) {
  const gross = +(
    order.amount ??
    order.total_revenue ??
    order.revenue ??
    order.total_amount ??
    order.order_amount ??
    0
  );
  const discount = +(order.discount_amount ?? 0);
  return Math.max(0, gross - discount);
}

/** Build lookup map: user_id -> display name */
function buildUserNameMap(users) {
  userNameById = new Map();
  for (const user of users) {
    const id = user.user_id ?? user.id;
    const name = String(user.name ?? user.full_name ?? user.sales_representative ?? '').trim();
    if (id != null && name) userNameById.set(Number(id), name);
  }
  return userNameById;
}

/** Agent / sales rep name for a single order row */
function orderAgent(order) {
  const direct = String(
    order.sales_representative ??
    order.agent_name ??
    order.representative ??
    order.sales_rep ??
    ''
  ).trim();
  if (direct) return direct;

  // Orders table stores the selling agent on created_by (not user_id/customer)
  const agentId = order.created_by ?? order.sales_rep_id ?? order.agent_id ?? order.user_id;
  if (agentId == null) return '';

  const name = userNameById.get(Number(agentId));
  return name ? name.trim() : '';
}

/** Pad month/day for ISO date strings */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Last day of a month (month is 1–12) */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** Compare YYYY-MM-DD strings */
function cmpDate(a, b) {
  return a.localeCompare(b);
}

function inRange(date, start, end) {
  return cmpDate(date, start) >= 0 && cmpDate(date, end) <= 0;
}

/**
 * Generic REST fetch helper for direct table access
 */
async function sbFetch(endpoint, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { ...HEADERS, ...extraHeaders },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${endpoint}`);
  return res.json();
}

/**
 * Fetch all rows from a table using pagination (Supabase max ~1000 rows/request)
 */
async function sbFetchAll(endpointBase, pageSize = 1000) {
  const rows = [];
  let offset = 0;

  while (true) {
    const sep = endpointBase.includes('?') ? '&' : '?';
    const page = await sbFetch(`${endpointBase}${sep}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

/**
 * Fetch all users once and cache for agent name lookup
 */
async function fetchAllUsers(forceRefresh = false) {
  if (cachedUsers && !forceRefresh) return cachedUsers;

  cachedUsers = await sbFetchAll('/users?select=user_id,name&order=user_id.asc');
  buildUserNameMap(cachedUsers);
  return cachedUsers;
}

/**
 * Fetch all orders once and cache for date-filtered dashboard builds
 */
async function fetchAllOrders(forceRefresh = false) {
  if (cachedOrders && !forceRefresh) return cachedOrders;

  await fetchAllUsers(forceRefresh);
  cachedOrders = await sbFetchAll('/orders?select=*&order=order_date_time.asc');
  return cachedOrders;
}

/**
 * Derive min/max available dates and the set of dates that have orders
 */
function getDateAvailability(orders) {
  const datesWithOrders = new Set();
  let minDate = null;
  let maxDate = null;

  for (const order of orders) {
    const d = orderDateStr(order);
    if (!d || d.length < 10) continue;
    datesWithOrders.add(d);
    if (!minDate || cmpDate(d, minDate) < 0) minDate = d;
    if (!maxDate || cmpDate(d, maxDate) > 0) maxDate = d;
  }

  return { minDate, maxDate, datesWithOrders };
}

/**
 * Build full dashboard payload for a specific report date from raw orders.
 */
function buildDashboardFromOrders(orders, reportDate) {
  const [y, m, d] = reportDate.split('-').map(Number);
  const monthStart = `${y}-${pad2(m)}-01`;
  const monthEnd   = reportDate;

  const prevMonth = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
  const pmStart = `${prevMonth.year}-${pad2(prevMonth.month)}-01`;
  const pmLastDay = lastDayOfMonth(prevMonth.year, prevMonth.month);
  const pmEnd = `${prevMonth.year}-${pad2(prevMonth.month)}-${pad2(pmLastDay)}`;
  const pmsdDay = Math.min(d, pmLastDay);
  const pmsdDate = `${prevMonth.year}-${pad2(prevMonth.month)}-${pad2(pmsdDay)}`;

  const todayOrders = [];
  const mtdOrders = [];
  const pmsdOrders = [];
  const pmOrders = [];
  const dailyMap = new Map();
  const monthlyMap = new Map();
  const lbToday = new Map();
  const lbMtd = new Map();

  for (const order of orders) {
    const od = orderDateStr(order);
    if (!od || od.length < 10) continue;

    const rev = orderRevenue(order);
    const agent = orderAgent(order) || `Agent #${order.created_by ?? order.user_id ?? '?'}`;

    if (od === reportDate) todayOrders.push(order);
    if (inRange(od, monthStart, monthEnd)) mtdOrders.push(order);
    if (od === pmsdDate) pmsdOrders.push(order);
    if (inRange(od, pmStart, pmEnd)) pmOrders.push(order);

    if (inRange(od, monthStart, monthEnd)) {
      if (!dailyMap.has(od)) dailyMap.set(od, { order_date: od, no_of_sales: 0, total_revenue: 0 });
      const day = dailyMap.get(od);
      day.no_of_sales += 1;
      day.total_revenue += rev;
    }

    const [oy, om] = od.split('-').map(Number);
    const monthKey = `${oy}-${pad2(om)}`;
    if (oy < y || (oy === y && om <= m)) {
      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, { year: oy, month: om, no_of_sales: 0 });
      }
      monthlyMap.get(monthKey).no_of_sales += 1;
    }

    if (od === reportDate) {
      if (!lbToday.has(agent)) lbToday.set(agent, { sales: 0, revenue: 0 });
      const t = lbToday.get(agent);
      t.sales += 1;
      t.revenue += rev;
    }

    if (inRange(od, monthStart, monthEnd)) {
      if (!lbMtd.has(agent)) lbMtd.set(agent, { sales: 0, revenue: 0 });
      const t = lbMtd.get(agent);
      t.sales += 1;
      t.revenue += rev;
    }
  }

  const sumSales = (list) => list.length;
  const sumRev = (list) => list.reduce((s, o) => s + orderRevenue(o), 0);

  const agents = new Set([...lbToday.keys(), ...lbMtd.keys()]);
  const leaderboard_metrics = [...agents].map((name) => ({
    sales_representative: name,
    today_sales: lbToday.get(name)?.sales ?? 0,
    today_revenue: lbToday.get(name)?.revenue ?? 0,
    mtd_sales: lbMtd.get(name)?.sales ?? 0,
    mtd_revenue: lbMtd.get(name)?.revenue ?? 0
  }));

  return {
    kpi_cards: {
      TODAY_SALES: sumSales(todayOrders),
      TODAY_REVENUE: sumRev(todayOrders),
      mtd_sales: sumSales(mtdOrders),
      MTD_REVENUE: sumRev(mtdOrders),
      PMSD_SALES: sumSales(pmsdOrders),
      PMSD_REVENUE: sumRev(pmsdOrders),
      PM_SALES: sumSales(pmOrders),
      PM_REVENUE: sumRev(pmOrders)
    },
    daily_metrics: [...dailyMap.values()].sort((a, b) => a.order_date.localeCompare(b.order_date)),
    monthly_metrics: [...monthlyMap.values()].sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    }),
    leaderboard_metrics
  };
}

/**
 * Load dashboard for a report date.
 */
async function fetchDashboard(reportDate) {
  const orders = await fetchAllOrders();
  const { minDate, maxDate } = getDateAvailability(orders);

  if (!minDate || !maxDate) {
    return { empty: true, reason: 'No order data found in Supabase.' };
  }

  if (cmpDate(reportDate, minDate) < 0 || cmpDate(reportDate, maxDate) > 0) {
    return {
      empty: true,
      reason: `No data for ${reportDate}. Available range: ${minDate} to ${maxDate}.`,
      minDate,
      maxDate
    };
  }

  return {
    empty: false,
    ...buildDashboardFromOrders(orders, reportDate)
  };
}