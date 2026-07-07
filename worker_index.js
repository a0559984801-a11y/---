async function getSupabaseClient(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    url: supabaseUrl, key: supabaseKey,
    async request(method, path, body = null) {
      const headers = { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'apikey': supabaseKey };
      const options = { method, headers };
      if (body) options.body = JSON.stringify(body);
      const response = await fetch(`${supabaseUrl}/rest/v1${path}`, options);
      return { status: response.status, data: await response.json() };
    },
    async rpc(functionName, params) {
      const headers = { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'apikey': supabaseKey };
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, { method: 'POST', headers, body: JSON.stringify(params) });
      return { status: response.status, data: await response.json() };
    }
  };
}

function parseICalEvents(icalText) {
  const events = [], lines = icalText.split('\n');
  let cur = null;
  for (const line of lines) {
    const l = line.trim();
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT' && cur) { events.push(cur); cur = null; }
    else if (cur && l.includes(':')) {
      const [key, ...vp] = l.split(':'), value = vp.join(':');
      if (key === 'DTSTART' || key.startsWith('DTSTART;')) cur.startDate = (value.includes(':') ? value.split(':').pop() : value).split('T')[0];
      else if (key === 'SUMMARY') cur.summary = value;
    }
  }
  return events;
}

function getStatus(s) {
  const v = (s || '').toLowerCase();
  if (v.includes('פנוי') || v.includes('free') || v.includes('available')) return 'פנוי';
  if (v.includes('התפנה')) return 'פנוי';
  if (v.includes('שמור') || v.includes('reserved') || v.includes('pending')) return 'שמור';
  return 'תפוס';
}

async function syncHall(hallName, icalUrl, sb) {
  console.log('syncHall start:', hallName, icalUrl);
  const r = await fetch(icalUrl);
  if (!r.ok) return { success: false, error: `HTTP ${r.status}` };
  const events = parseICalEvents(await r.text());
  console.log('Events parsed:', events.length);
  const eventDates = new Map();
  events.forEach(e => e.startDate && eventDates.set(e.startDate, e));
  const today = new Date(), end = new Date(today);
  end.setDate(end.getDate() + 365);
  
  const rows = [];
  for (let d = new Date(today); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const status_value = eventDates.has(dateStr) ? getStatus(eventDates.get(dateStr).summary) : 'פנוי';
    rows.push({ p_date: dateStr, p_hall_name: hallName, p_status: status_value });
  }
  
  const { status } = await sb.rpc('sync_availability_batch', rows);
  console.log('Batch sync:', hallName, status);
  return { success: status < 400, synced: rows.length };
}

async function syncAll(env) {
  console.log('Starting sync, SUPABASE_URL:', env.SUPABASE_URL);
  const sb = await getSupabaseClient(env);
  const { status, data } = await sb.request('GET', '/calendar_urls?select=id,hall_id,url,halls(name)&is_active=eq.true');
  console.log('calendar_urls status:', status, 'data length:', data?.length);
  if (status >= 400) return { success: false, error: `calendar_urls fetch failed: ${status}` };
  if (!Array.isArray(data) || !data.length) return { success: true, message: 'No active URLs', synced: 0 };
  const results = {};
  let total = 0;
  for (const row of data) {
    const name = row.halls?.name || `hall_${row.hall_id}`;
    console.log('Syncing hall:', name, 'URL:', row.url);
    const res = await syncHall(name, row.url, sb);
    console.log('Sync result:', name, res);
    results[name] = res;
    if (res.success) total += res.synced || 0;
  }
  return { success: true, synced: total, results };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/sync') {
      const result = await syncAll(env);
      return new Response(JSON.stringify(result, null, 2), { status: result.success ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  },
  async scheduled(event, env) { await syncAll(env); }
};
