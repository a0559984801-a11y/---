/**
 * Cloudflare Worker: iCal to Supabase Sync - Updated
 */

async function getSupabaseClient(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  
  return {
    url: supabaseUrl,
    key: supabaseKey,
    
    async request(method, path, body = null) {
      const headers = {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      };
      
      const options = {
        method,
        headers,
      };
      
      if (body) {
        options.body = JSON.stringify(body);
      }
      
      const response = await fetch(`${supabaseUrl}/rest/v1${path}`, options);
      return {
        status: response.status,
        data: await response.json(),
      };
    },
    
    async rpc(functionName, params) {
      const headers = {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      };
      
      const response = await fetch(
        `${supabaseUrl}/rest/v1/rpc/${functionName}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
        }
      );
      
      return {
        status: response.status,
        data: await response.json(),
      };
    },
  };
}

function parseICalEvents(icalText) {
  const events = [];
  const lines = icalText.split('\n');
  
  let currentEvent = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT' && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    } else if (currentEvent && line.includes(':')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':');
      
      if (key === 'DTSTART' || key.startsWith('DTSTART;')) {
        const dateStr = value.includes(':') ? value.split(':').pop() : value;
        currentEvent.startDate = dateStr.split('T')[0];
      } else if (key === 'DTEND' || key.startsWith('DTEND;')) {
        const dateStr = value.includes(':') ? value.split(':').pop() : value;
        currentEvent.endDate = dateStr.split('T')[0];
      } else if (key === 'SUMMARY') {
        currentEvent.summary = value;
      } else if (key === 'DESCRIPTION') {
        currentEvent.description = value;
      }
    }
  }
  
  return events;
}

function getStatus(eventSummary) {
  const summary = (eventSummary || '').toLowerCase();
  
  if (summary.includes('פנוי') || summary.includes('free') || summary.includes('available')) {
    return 'פנוי';
  } else if (summary.includes('שמור') || summary.includes('reserved') || summary.includes('pending') || summary.includes('option')) {
    return 'שמור';
  }
  
  return 'תפוס';
}

async function syncHallCalendar(hallId, hallName, icalUrl, supabaseClient) {
  try {
    const icalResponse = await fetch(icalUrl);
    if (!icalResponse.ok) {
      console.error(`Failed to fetch iCal for ${hallName}: ${icalResponse.status}`);
      return { success: false, error: `HTTP ${icalResponse.status}` };
    }
    
    const icalText = await icalResponse.text();
    const events = parseICalEvents(icalText);
    
    // קבל 365 יום הבאים (שנה שלמה)
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 365);
    
    // צור set של תאריכים עם events
    const eventDates = new Map();
    events.forEach(e => {
      if (e.startDate) {
        eventDates.set(e.startDate, e);
      }
    });
    
    let successCount = 0;
    
    // סנכרן כל תאריך ל-90 יום
    for (let d = new Date(today); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      
      let status_value = 'פנוי';
      
      if (eventDates.has(dateStr)) {
        const event = eventDates.get(dateStr);
        status_value = getStatus(event.summary);
      }
      
      const { status, data } = await supabaseClient.rpc('sync_availability', {
        p_date: dateStr,
        p_hall_name: hallName,
        p_status: status_value,
      });
      
      if (status < 400) {
        successCount++;
      } else {
        console.warn(`Failed to sync ${hallName} on ${dateStr}: ${status}`);
      }
    }
    
    return { success: true, eventCount: events.length, synced: successCount };
  } catch (error) {
    console.error(`Error syncing ${hallName}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function syncAllCalendars(env) {
  console.log('Starting iCal sync...');
  
  const supabaseClient = await getSupabaseClient(env);
  
  try {
    const { status, data } = await supabaseClient.request(
      'GET',
      '/halls?select=id,name,ical_url&ical_url=not.is.null'
    );
    
    if (status >= 400) {
      throw new Error(`Failed to fetch halls: ${status}`);
    }
    
    if (!Array.isArray(data) || data.length === 0) {
      return {
        success: true,
        message: 'No halls with iCal URLs configured',
        synced: 0,
      };
    }
    
    const results = {};
    let totalSynced = 0;
    
    for (const hall of data) {
      if (hall.ical_url) {
        const syncResult = await syncHallCalendar(
          hall.id,
          hall.name,
          hall.ical_url,
          supabaseClient
        );
        results[hall.name] = syncResult;
        if (syncResult.success) {
          totalSynced += syncResult.synced || 0;
        }
      }
    }
    
    return {
      success: true,
      message: 'Sync completed',
      synced: totalSynced,
      results,
    };
  } catch (error) {
    console.error('Sync error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    if (url.pathname === '/sync') {
      const result = await syncAllCalendars(env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  
  async scheduled(event, env) {
    console.log('Cron trigger fired at', new Date().toISOString());
    const result = await syncAllCalendars(env);
    console.log('Sync result:', JSON.stringify(result));
  },
};
