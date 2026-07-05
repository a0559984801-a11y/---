# Cloudflare Worker Cron Deployment Guide

## קבצים הנדרשים

```
wrangler.toml          - Worker configuration
src/index.js          - Worker code (תן שם ל-index.js)
```

---

## צעד 1: Setup Local Environment

### 1.1 Install Wrangler CLI
```bash
npm install -g @cloudflare/wrangler
# או
npm install -g wrangler
```

### 1.2 Create project directory
```bash
mkdir cloudflare-ical-sync
cd cloudflare-ical-sync

# Copy files from outputs:
cp ../wrangler.toml ./
mkdir -p src
cp ../worker_index.js ./src/index.js
```

### 1.3 Test locally (optional)
```bash
wrangler dev
# ניתן לבדוק ב-http://localhost:8787/sync
```

---

## צעד 2: Authentication

### 2.1 Login to Cloudflare
```bash
wrangler login
# יפתח browser כדי לאישור הנתונים
```

### 2.2 Verify authentication
```bash
wrangler whoami
# הודיע שאתה מחובר בהצלחה
```

---

## צעד 3: Deploy

### 3.1 Deploy the Worker
```bash
wrangler publish
# או: wrangler deploy
```

### הצפה:
```
✓ Successfully published your Worker
✓ Your Worker has been deployed to:
  ical-sync.{account}.workers.dev
```

### 3.2 Verify deployment
```bash
curl https://ical-sync.{account}.workers.dev/health
# Should return: {"status":"ok"}
```

---

## צעד 4: Configure Environment Variables

### 4.1 Update wrangler.toml with actual values
```toml
[env.production.vars]
SUPABASE_URL = "https://mzrnwtwyuligsaxeoxhh.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "your_actual_service_role_key"
```

⚠️ **Get SERVICE_ROLE_KEY from:**
- Supabase Dashboard
- Project Settings → API
- Copy "service_role" secret key (חשוב: זה בטוח להשתמש בCF Worker)

### 4.2 Update wrangler.toml with KV namespace (optional)
```bash
wrangler kv:namespace list
# יראה את ה-KV namespaces שלך

# Update wrangler.toml:
[[kv_namespaces]]
binding = "ICAL_CACHE"
id = "your_actual_id"
preview_id = "your_preview_id"
```

---

## צעד 5: Configure Cron Trigger

### 5.1 In Cloudflare Dashboard

1. Go to: https://dash.cloudflare.com/workers/services
2. Select: **ical-sync** service
3. Click: **Settings** tab
4. Find: **Triggers** section
5. Click: **Add Cron Trigger**
6. Enter Schedule: `0 */12 * * *`
   - Meaning: Every 12 hours at minute 0
   - Examples:
     - `0 */6 * * *` = Every 6 hours
     - `0 0 * * *` = Daily at midnight
     - `0 0 * * 0` = Weekly on Sunday

7. Click: **Deploy**

### 5.2 Verify Cron is active
```bash
# In Cloudflare Dashboard → ical-sync → Triggers
# Should show: "Cron Trigger: 0 */12 * * * (next execution: ...)"
```

---

## צעד 6: Populate iCal URLs

### 6.1 Add calendar URLs to halls table

Run this in **Supabase SQL Editor**:

```sql
-- Update halls with iCal URLs
-- Get Google Calendar ID from: Google Calendar → Settings → Calendar → iCal Address

UPDATE halls 
SET ical_url = 'https://calendar.google.com/calendar/ical/{CALENDAR_ID}/basic.ics'
WHERE name = 'שם האולם';

-- Example:
UPDATE halls 
SET ical_url = 'https://calendar.google.com/calendar/ical/abc123@group.calendar.google.com/basic.ics'
WHERE name = 'אולם הזהב';

-- Verify:
SELECT id, name, ical_url FROM halls WHERE ical_url IS NOT NULL;
```

---

## צעד 7: Test the Sync

### 7.1 Manual HTTP test
```bash
curl -X GET https://ical-sync.{account}.workers.dev/sync

# Response:
{
  "success": true,
  "message": "Sync completed",
  "synced": 5,
  "results": {
    "אולם הזהב": { "success": true, "eventCount": 45 },
    ...
  }
}
```

### 7.2 Check Supabase for updates
```sql
-- Check availability was synced
SELECT * FROM availability 
WHERE date >= CURRENT_DATE 
ORDER BY date DESC 
LIMIT 10;
```

### 7.3 Watch logs
```bash
wrangler tail
# Shows real-time logs from your Worker
```

---

## צעד 8: Monitor & Maintain

### 8.1 Check execution logs
```bash
# Cloudflare Dashboard → Workers → ical-sync → Logs
```

### 8.2 Update schedule if needed
- In Cloudflare Dashboard → Triggers
- Delete old Cron
- Add new one with different schedule

### 8.3 Update iCal URLs
- Whenever a hall adds/changes their Google Calendar
- Run SQL UPDATE in Supabase

---

## Troubleshooting

### Worker not triggering at scheduled time
1. Verify Cron is enabled in Dashboard
2. Check "next execution" timestamp
3. Run `wrangler tail` to see logs
4. Test with manual HTTP call first

### iCal parsing errors
1. Verify iCal URL is valid
   ```bash
   curl "https://calendar.google.com/calendar/ical/.../basic.ics"
   ```
2. Check iCal format is standard RFC 5545
3. Look at Worker logs for error details

### Supabase auth errors
1. Verify SERVICE_ROLE_KEY in wrangler.toml
2. Check Supabase project is active
3. Verify table permissions allow INSERT/UPDATE

---

## Files Summary

| File | Purpose |
|------|---------|
| `wrangler.toml` | Configuration (Cron schedule, env vars) |
| `src/index.js` | Handler code (sync logic) |

---

## שאלות? בעיות?

Check logs:
```bash
wrangler tail
```

Or visit Cloudflare Dashboard → ical-sync → Logs
