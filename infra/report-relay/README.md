# Report relay

Cloudflare Worker that receives bug-report bundles from the extension's
"Report a problem" dialog and forwards them to a private Discord channel.
The Discord webhook URL stays server-side as a Worker secret so it never
ships inside the extension package.

## Deploy

1. Create a **private** channel in the Koretex Discord (e.g. `#alpha-reports`,
   role-gated to the team) → channel settings → Integrations → Webhooks →
   New Webhook → copy the URL.
2. From this directory:

   ```sh
   npx wrangler login
   npx wrangler secret put DISCORD_WEBHOOK_URL   # paste the webhook URL
   npx wrangler secret put ALPHA_TOKEN           # any long random string, e.g. `openssl rand -hex 24`
   npx wrangler deploy
   ```

3. Note the deployed URL (e.g. `https://koretex-report-relay.<account>.workers.dev`)
   and set it, together with the same ALPHA_TOKEN value, in
   `extension/pages/side-panel/src/config/report.ts`. Rebuild the extension.

## Rotation

- Spam through the relay → rotate `ALPHA_TOKEN` (secret + extension config, rebuild).
- Webhook leaked some other way → delete/recreate the Discord webhook and update the secret.
  Shipped builds keep working; only the Worker needs the new value.

## Contract

`POST /` with `Authorization: Bearer <ALPHA_TOKEN>` and JSON body:

```json
{ "description": "what the tester typed", "filename": "koretex-trace-….json", "bundle": { "meta": {…}, … } }
```

2MB body cap. Responds `{ "ok": true }` or `{ "error": "…" }`.
