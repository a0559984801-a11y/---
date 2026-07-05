/**
 * Cloudflare Worker: iCal to Supabase Sync
 * Handles both HTTP requests and Cron triggers
 * 
 * Syncs Google Calendar iCal feeds to Supabase availability table
 */

// Supabase client helper
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
  };
}

// Parse iCal format and extract events
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
      
      if (key === 'DTSTART') {
        currentEvent.startDate = value.split('T')[0];
      } else if (key === 'DTEND') {
        currentEvent.endDate = value.split('T')[0];
      } else if (key === 'SUMMARY') {
        currentEvent.summary = value;
      } else if (key === 'DESCRIPTION') {
        currentEvent.description = value;
      }
    }
  }
  
  return events;
}

// Map event summary to availability status
function getStatus(eventSummary) {
  const summary = (eventSummary || '').toLowerCase();
  
  if (summary.includes('taken') || summary.includes('booked') || summary.includes('תפוס')) {
    return 'תפוס';
  } else if (summary.includes('reserved') || summary.includes('pending') || summary.includes('שמור')) {
    return 'שמור';
  }
  
  return 'פנוי';
}

// Sync a single hall's iCal URL
async function syncHallCalendar(hallId, hallName, icalUrl, supabaseClient) {
  try {
    // Fetch iCal feed
    const icalResponse = await fetch(icalUrl);
    if (!icalResponse.ok) {
      console.error(`Failed to fetch iCal for ${hallName}: ${icalResponse.status}`);
      return { success: false, error: `HTTP ${icalResponse.status}` };
    }
    
    const icalText = await icalResponse.text();
    const events = parseICalEvents(icalText);
    
    // Insert/update availability records
    for (const event of events) {
      if (!event.startDate) continue;
      
      const availability = {
        date: event.startDate,
        hall_name: hallName,
        status: getStatus(event.summary),
      };
      
      // Upsert: update if exists, insert if not
      const { status, data } = await supabaseClient.request(
        'POST',
        '/availability',
        availability
      );
      
      if (status >= 400) {
        console.warn(`Failed to sync ${hallName} on ${event.startDate}: ${status}`);
      }
    }
    
    return { success: true, eventCount: events.length };
  } catch (error) {
    console.error(`Error syncing ${hallName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Main sync function - called by both HTTP and Cron
async function syncAllCalendars(env) {
  console.log('Starting iCal sync...');
  
  const supabaseClient = await getSupabaseClient(env);
  
  try {
    // Fetch all halls with ical_url
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
    
    // Sync each hall
    const results = {};
    for (const hall of data) {
      if (hall.ical_url) {
        results[hall.name] = await syncHallCalendar(
          hall.id,
          hall.name,
          hall.ical_url,
          supabaseClient
        );
      }
    }
    
    return {
      success: true,
      message: 'Sync completed',
      synced: data.length,
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

// Export handler
export default {
  // HTTP endpoint handler
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Sync endpoint
    if (url.pathname === '/sync' && request.method === 'POST') {
      const result = await syncAllCalendars(env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // GET /sync also works
    if (url.pathname === '/sync' && request.method === 'GET') {
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
  
  // Cron trigger handler
  async scheduled(event, env) {
    console.log('Cron trigger fired at', new Date().toISOString());
    const result = await syncAllCalendars(env);
    console.log('Sync result:', JSON.stringify(result));
  },
};
