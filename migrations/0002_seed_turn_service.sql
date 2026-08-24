-- Seeds the built-in service row used to tag/audit Cloudflare Realtime TURN
-- credentials issued to authenticated (SIWE) users via POST /turn/credentials.
INSERT INTO services (id, name, description, created_at)
SELECT
  'svc_cloudflare_turn',
  'Cloudflare Realtime TURN',
  'Built-in: ephemeral TURN credentials issued to SIWE-authenticated users',
  strftime('%s', 'now')
WHERE NOT EXISTS (SELECT 1 FROM services WHERE id = 'svc_cloudflare_turn');
