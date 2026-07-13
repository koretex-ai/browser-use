/**
 * fetch with a hard timeout, composed with the task's cancel signal.
 *
 * A model call with no timeout is a silent forever-hang: if the connection
 * stalls (network drop, provider wedge), the task waits with no way to break
 * out. This wraps fetch so a stall becomes a clean, catchable error the
 * conductor can reflect on, report, or persist as resumable — never an
 * eternal spinner. User cancellation (parentSignal) is preserved and remains
 * distinguishable from a timeout: on cancel the error propagates as an
 * AbortError; on timeout it is a plain Error with a clear message.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // A timeout fires while the PARENT signal is NOT aborted — surface it as a
    // real error so callers (which treat parentSignal.aborted as "cancelled")
    // handle it as a failure, not a silent stop
    if (timedOut && !parentSignal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (no response from the model endpoint)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}
