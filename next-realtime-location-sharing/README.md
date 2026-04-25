# Realtime Location Sharing

This is a standalone Next.js JavaScript app that provides Google Maps or Grab style live location sharing with:

- `navigator.geolocation.watchPosition`
- Supabase database + realtime subscriptions
- Leaflet + OpenStreetMap
- IP-based approximate fallback when GPS is unavailable

## Setup

1. From `/Users/francisjakeroaya/ConvoyApp/next-realtime-location-sharing`, copy `.env.example` to `.env.local`
2. Fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Run the SQL in the matching Supabase migration file:
   - `/supabase/migrations/20260425095500_create_realtime_locations.sql`
4. Install dependencies:
   - `npm install`
5. Start the app:
   - `npm run dev`

## Routes

- `/` tracks the current device and shows all active users
- `/track/[user_id]` shows a shareable live tracking page for one user

## Notes

- Browsers require HTTPS for geolocation except on localhost
- iPhone Safari and Android Chrome work best when the page stays in the foreground
- The UI prioritizes live GPS, falls back to approximate IP location after bounded retries, and automatically switches back to GPS when a precise fix becomes available
- The SQL policies in this demo are intentionally open so share links work immediately. Lock them down with auth rules for production.
