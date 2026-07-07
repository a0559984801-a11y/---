async function getSupabaseClient(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    url: supabaseUrl,
    key: supabaseKey,
    async request(method, path, body = null) {
      const headers = {'Authorization': `Bearer ${supabaseKey}`,'Content-Type': 'application/json','apikey': supabaseKey};
      const options = {method, headers};
      if (body) options.body = JSON.stringify(body);
      const response = await fetch(`${supabaseUrl}/rest/v1${path}`, options);
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
      return {status: response.status, data: await response.json()};
    }
  };
}

function parseICalEvents(icalText) {
  const events = [];
  const lines = icalText.split('\n');
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') current = {};
    else if (trimmed === 'END:VEVENT' && current) {events.push(current); current = null;}
    else if (current && trimmed.includes(':')) {
      const [key, ...rest] = trimmed.split(':');
      const value = rest.join(':');
      if (key === 'DTSTART' || key.startsWith('DTSTART;')) {
        const dateStr = (value.includes(':') ? value.split(':').pop() : value).split('T')[0];
        current.startDate = dateStr;
      } else if (key === 'SUMMARY') current.summary = value;
    }
  }
  return events;
}

export default {
  async fetch(request, env) {
    return new Response('Worker running');
  },
  async scheduled(event, env) {
    try {
      const client = await getSupabaseClient(env);
      const {data: urls} = await client.request('GET', '/calendar_urls');
      if (!urls || !urls.length) return;
      const availability = {};
      for (const entry of urls) {
        if (!entry.hall_id || !entry.ical_url) continue;
        try {
          const response = await fetch(entry.ical_url);
          if (!response.ok) continue;
          const events = parseICalEvents(await response.text());
          for (const event of events) {
            const date = event.startDate;
            if (!date) continue;
            if (!availability[date]) availability[date] = {};
            const isShamur = event.summary && event.summary.includes('שמור');
            availability[date][entry.hall_id] = isShamur ? 'שמור' : 'פנוי';
          }
        } catch (e) {
          console.error(`Error: ${e.message}`);
        }
      }
      const updates = Object.entries(availability).map(([date, halls]) => ({date, ...halls}));
      if (updates.length > 0) {
        await client.request('PATCH', '/זמינות', updates);
      }
    } catch (e) {
      console.error(`Task error: ${e.message}`);
    }
  }
};
