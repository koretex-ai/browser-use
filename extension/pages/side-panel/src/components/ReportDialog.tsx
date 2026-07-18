import { useEffect, useState } from 'react';
import { buildRunBundle, bundleFilename, downloadBundle, type RunBundle } from '../utils/reportBundle';
import { REPORT_RELAY_URL, REPORT_ALPHA_TOKEN } from '../config/report';

interface ReportDialogProps {
  sessionId: string;
  onClose: () => void;
}

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * "Report a problem" dialog. Nothing leaves the machine until the tester
 * presses Send — the dialog shows exactly what the bundle contains first
 * (text-only: trace + journal + settings metadata; screenshots and the API
 * key are never included).
 */
const ReportDialog = ({ sessionId, onClose }: ReportDialogProps) => {
  const [bundle, setBundle] = useState<RunBundle | null>(null);
  const [description, setDescription] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [sendState, setSendState] = useState<SendState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    buildRunBundle(sessionId)
      .then(b => (b ? setBundle(b) : setError('Could not load this session.')))
      .catch(() => setError('Could not load this session.'));
  }, [sessionId]);

  const canSend = Boolean(REPORT_RELAY_URL && REPORT_ALPHA_TOKEN);

  const handleSend = async () => {
    if (!bundle) return;
    setSendState('sending');
    setError(null);
    try {
      const res = await fetch(REPORT_RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REPORT_ALPHA_TOKEN}` },
        body: JSON.stringify({ description: description.trim(), filename: bundleFilename(bundle), bundle }),
      });
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
      setSendState('sent');
    } catch (e) {
      console.error('report send failed:', e);
      setSendState('failed');
      setError('Sending failed — you can download the bundle below and share it on Discord instead.');
    }
  };

  const inputClass =
    'w-full rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:border-white focus:outline-none';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
      <div className="max-h-full w-full overflow-y-auto rounded-lg border border-white/25 bg-[#0A0A0A] p-3">
        <div className="mb-2 text-sm font-semibold text-white">Report a problem</div>

        {!bundle && !error && <div className="text-xs text-gray-400">Preparing the trace bundle…</div>}

        {bundle && sendState !== 'sent' && (
          <>
            <div className="mb-2 rounded-md border border-white/15 bg-black p-2 text-xs text-gray-300">
              <div className="mb-1 text-gray-400">This report contains (text only — no screenshots, no API key):</div>
              <div>Task: {bundle.meta.objective.slice(0, 120)}</div>
              <div>
                {bundle.trace.length} trace lines · v{bundle.meta.version} · {bundle.meta.navigatorModel}
                {bundle.runState ? ` · journal ${bundle.runState.journal.length} lines` : ''}
              </div>
              <button
                type="button"
                onClick={() => setShowRaw(!showRaw)}
                className="mt-1 cursor-pointer text-gray-400 underline hover:text-white">
                {showRaw ? 'Hide raw contents' : 'View raw contents'}
              </button>
              {showRaw && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] text-gray-400">
                  {JSON.stringify(bundle, null, 2)}
                </pre>
              )}
            </div>

            <div className="mb-2 text-[11px] leading-snug text-amber-300/90">
              The trace can include content from pages the agent worked on in your logged-in browser. Review it before
              sending; the team treats reports as confidential.
            </div>

            <label className="mb-1 block text-xs text-gray-400" htmlFor="report-description">
              What went wrong? What did you expect?
            </label>
            <textarea
              id="report-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              placeholder="e.g. It kept clicking the wrong filter and then gave up"
              className={`${inputClass} resize-none`}
            />

            {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-white/30 px-3 py-1 text-sm text-gray-300 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => downloadBundle(bundle)}
                className="rounded-md border border-white/30 px-3 py-1 text-sm text-gray-300 hover:text-white">
                Download bundle
              </button>
              {canSend && (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={sendState === 'sending'}
                  className="rounded-md bg-white px-3 py-1 text-sm font-medium text-black hover:bg-gray-200 disabled:opacity-50">
                  {sendState === 'sending' ? 'Sending…' : 'Send to Koretex'}
                </button>
              )}
            </div>
            {!canSend && (
              <div className="mt-2 text-right text-[11px] text-gray-500">
                Direct send is not configured in this build — download the bundle and share it on our Discord.
              </div>
            )}
          </>
        )}

        {sendState === 'sent' && (
          <div>
            <div className="mb-3 text-sm text-green-400">Report sent — thank you! We read every one.</div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-white px-3 py-1 text-sm font-medium text-black hover:bg-gray-200">
                Close
              </button>
            </div>
          </div>
        )}

        {!bundle && error && (
          <div>
            <div className="mb-3 text-xs text-red-400">{error}</div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-white/30 px-3 py-1 text-sm text-gray-300 hover:text-white">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReportDialog;
