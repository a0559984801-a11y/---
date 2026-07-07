async function getSupabaseClient(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return {
    url: supabaseUrl,
    key: supabaseKey,
    async request(method, path, body) {
      const headers = {
        "Authorization": "Bearer " + supabaseKey,
        "Content-Type": "application/json",
        "apikey": supabaseKey
      };
      const options = { method: method, headers: headers };
      if (body) options.body = JSON.stringify(body);
      const response = await fetch(supabaseUrl + "/rest/v1" + path, options);
      if (!response.ok) throw new Error(method + " " + path + ": " + response.status);
      return { status: response.status, data: await response.json() };
    }
  };
}

function parseICalEvents(icalText) {
  const events = [];
  const lines = icalText.split("\n");
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      current = {};
    } else if (trimmed === "END:VEVENT" && current) {
      events.push(current);
      current = null;
    } else if (current && trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      const key = trimmed.slice(0, idx);
      const value = trimmed.slice(idx + 1);
      if (key === "DTSTART" || key.startsWith("DTSTART;")) {
        current.startDate = (value.includes("T") ? value.split("T")[0] : value).replace(/Z$/, "");
      } else if (key === "SUMMARY") {
        current.summary = value;
      }
    }
  }
  return events;
}

function getStatus(summary) {
  if (!summary) return "פנוי";
  if (summary.includes("שמור")) return "שמור";
  if (summary.includes("תפוס")) return "תפוס";
  return "פנוי";
}

export default {
  async fetch(request, env) {
    return new Response("Worker running", { status: 200 });
  },

  async scheduled(event, env) {
    try {
      const client = await getSupabaseClient(env);

      const urlsResp = await client.request("GET", "/calendar_urls?select=hall_id,url&is_active=eq.true");
      const urls = urlsResp.data || [];
      console.log("Found " + urls.length + " calendar URLs");
      if (!urls.length) return;

      const hallsResp = await client.request("GET", "/halls?select=id,name");
      const hallMap = {};
      for (const h of (hallsResp.data || [])) hallMap[h.id] = h.name;

      const availability = {};
      for (const entry of urls) {
        if (!entry.hall_id || !entry.url) continue;
        const hallName = hallMap[entry.hall_id];
        if (!hallName) continue;
        try {
          console.log("Syncing " + hallName);
          const response = await fetch(entry.url);
          if (!response.ok) continue;
          const events = parseICalEvents(await response.text());
          console.log(hallName + ": " + events.length + " events");
          for (const ev of events) {
            const date = ev.startDate;
            if (!date) continue;
            if (!availability[date]) availability[date] = {};
            availability[date][hallName] = getStatus(ev.summary);
          }
        } catch (e) {
          console.error("Error syncing " + hallName + ": " + e.message);
        }
      }

      const rows = Object.entries(availability).map(function(entry) {
        const row = {};
        row["תאריך"] = entry[0];
        Object.assign(row, entry[1]);
        return row;
      });

      if (rows.length > 0) {
        console.log("Upserting " + rows.length + " rows");
        await client.request("POST", "/rpc/sync_availability", { rows: rows });
        console.log("Done");
      }
    } catch (e) {
      console.error("Task error: " + e.message);
    }
  }
};