/**
 * Bug-report relay endpoint (infra/report-relay). Reports are only ever sent
 * when the user presses Send in the report dialog — never automatically.
 *
 * REPORT_RELAY_URL empty = the Send path is hidden and only the local
 * "Download bundle" option is offered (e.g. for builds outside the alpha).
 * ALPHA_TOKEN is a shared, rotatable gate against relay spam — it is not a
 * secret in the cryptographic sense (it ships in the bundle) and protects
 * the Discord channel only in combination with the relay's rate limiting.
 */
export const REPORT_RELAY_URL = 'https://koretex-report-relay.app-cf4.workers.dev';
export const REPORT_ALPHA_TOKEN = '41ed1409ccf01a05662068cef46e1ef2985357700d29a29e';
