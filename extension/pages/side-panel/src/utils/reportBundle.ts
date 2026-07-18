import { chatHistoryStore, runStateStore, chatSettingsStore } from '@extension/storage';

/**
 * A self-contained, text-only serialization of one run for bug reports.
 * Screenshots (message.image data-URLs) are deliberately STRIPPED — they are
 * the most sensitive artifact a run produces and the tester cannot easily
 * review pixels for leaks. Everything else is exactly what the side panel
 * already displays: the trace is the debugging surface.
 */
export interface RunBundle {
  meta: {
    bundleId: string;
    createdAt: string;
    version: string;
    objective: string;
    sessionTitle: string;
    messageCount: number;
    /** Model/settings context — never includes the API key */
    navigatorModel: string;
    orchestratorModel: string;
    orchestratorBaseUrl: string;
    localModel: string;
    cloudOnly: boolean;
    piiGuard: boolean;
  };
  trace: Array<{ actor: string; content: string; meta?: string; timestamp: number }>;
  runState: {
    status: string;
    journal: string[];
    collectionSize: number;
    plansUsed: number;
  } | null;
}

export async function buildRunBundle(sessionId: string): Promise<RunBundle | null> {
  const session = await chatHistoryStore.getSession(sessionId);
  if (!session) return null;

  const [settings, runState] = await Promise.all([chatSettingsStore.getSettings(), runStateStore.getRun(sessionId)]);

  const firstUserMessage = session.messages.find(m => m.actor === 'user');

  return {
    meta: {
      bundleId: `${new Date().toISOString().slice(0, 10)}-${sessionId.slice(-6)}`,
      createdAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      objective: firstUserMessage?.content ?? '(none)',
      sessionTitle: session.title,
      messageCount: session.messages.length,
      navigatorModel: settings.navigatorModel || settings.orchestratorModel,
      orchestratorModel: settings.orchestratorModel,
      orchestratorBaseUrl: settings.orchestratorBaseUrl,
      localModel: settings.model,
      cloudOnly: settings.cloudOnly,
      piiGuard: settings.piiGuard,
    },
    trace: session.messages.map(({ actor, content, meta, timestamp }) => ({
      actor,
      content,
      ...(meta ? { meta } : {}),
      timestamp,
    })),
    runState: runState
      ? {
          status: runState.status,
          journal: runState.journal,
          collectionSize: runState.collection.length,
          plansUsed: runState.plansUsed,
        }
      : null,
  };
}

export function bundleFilename(bundle: RunBundle): string {
  return `koretex-trace-${bundle.meta.bundleId}.json`;
}

export function downloadBundle(bundle: RunBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundleFilename(bundle);
  a.click();
  URL.revokeObjectURL(url);
}
