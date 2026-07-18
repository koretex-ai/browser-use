/**
 * Koretex report relay — receives bug-report bundles from the extension and
 * forwards them to a private Discord channel via webhook.
 *
 * Why a relay: the Discord webhook URL must never ship inside the extension
 * package (anyone can unzip it and spam the channel). The webhook lives here
 * as a Worker secret; the extension only knows this endpoint and a shared
 * alpha token that can be rotated independently.
 *
 * Secrets (set with `wrangler secret put <NAME>`):
 *   DISCORD_WEBHOOK_URL — the #alpha-reports channel webhook
 *   ALPHA_TOKEN         — shared bearer token baked into alpha builds
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB: text-only bundles are ~10-100KB

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'POST') return json(405, { error: 'POST only' });

    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.ALPHA_TOKEN}`) return json(401, { error: 'bad token' });

    const length = Number(request.headers.get('Content-Length') || '0');
    if (length > MAX_BODY_BYTES) return json(413, { error: 'bundle too large' });

    let report;
    try {
      report = await request.json();
    } catch {
      return json(400, { error: 'invalid JSON' });
    }

    const description = String(report.description || '').slice(0, 1500);
    const bundle = report.bundle;
    if (!bundle || typeof bundle !== 'object') return json(400, { error: 'missing bundle' });

    const meta = bundle.meta || {};
    const filename = String(report.filename || 'koretex-trace.json').replace(/[^\w.-]/g, '_');

    // Discord message: human-readable summary up top, full bundle attached.
    const summary = [
      `**New alpha report** \`${meta.bundleId || 'no-id'}\``,
      `**Version:** ${meta.version || '?'} · **Navigator:** ${meta.navigatorModel || '?'} · **Cloud-only:** ${meta.cloudOnly ? 'yes' : 'no'}`,
      `**Objective:** ${String(meta.objective || '(none)').slice(0, 300)}`,
      description ? `**Tester says:** ${description}` : '**Tester says:** (no description)',
    ].join('\n');

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: summary.slice(0, 2000) }));
    form.append('files[0]', new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), filename);

    const discord = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
    if (!discord.ok) {
      const detail = await discord.text().catch(() => '');
      console.error('discord forward failed', discord.status, detail.slice(0, 500));
      return json(502, { error: 'forward failed' });
    }

    return json(200, { ok: true });
  },
};
