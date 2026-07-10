import type { Action } from '@extension/storage';
import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('planner');

export interface PlannerDecision {
  reasoning: string;
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'back' | 'done' | 'respond';
  index?: number;
  /** Visual description for the grounder when the element is not in the PAGE list */
  target?: string;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  message?: string;
}

export interface Verdict {
  valid: boolean;
  reason: string;
}

// Tolerant JSON extraction: strip code fences, fall back to the first {...} block
function parseJsonObject<T>(content: string): T {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Model did not return JSON: ${content.slice(0, 120)}`);
  }
}

// One non-streaming JSON-mode call to the local model.
// NOTE: Ollama's schema-constrained `format` is unreliable with think:false on
// qwen3.5 (returns prose), so we use plain json mode + the shape in the prompt.
async function callStructured<T>(systemPrompt: string, userContent: string, signal: AbortSignal): Promise<T> {
  const { baseUrl, model } = await chatSettingsStore.getSettings();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.1 },
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed (HTTP ${response.status}). Is Ollama running at ${baseUrl}?`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  const content = data.message?.content ?? '';
  logger.info('structured response:', content.slice(0, 300));
  return parseJsonObject<T>(content);
}

export async function planNextAction(
  systemPrompt: string,
  turn: string,
  signal: AbortSignal,
): Promise<PlannerDecision> {
  const decision = await callStructured<PlannerDecision>(systemPrompt, turn, signal);
  if (typeof decision.action !== 'string') throw new Error('Planner returned no action');
  return decision;
}

export async function validateCompletion(systemPrompt: string, turn: string, signal: AbortSignal): Promise<Verdict> {
  const verdict = await callStructured<Verdict>(systemPrompt, turn, signal);
  return { valid: Boolean(verdict.valid), reason: verdict.reason ?? '' };
}

// Convert a planner decision into a typed executor action.
// Returns null for respond/done (loop handles those) and for click-by-target
// (loop routes it through the vision grounder first).
export function decisionToAction(decision: PlannerDecision): Action | { error: string } | null {
  switch (decision.action) {
    case 'click':
      if (decision.index === undefined) {
        if (decision.target) return null; // grounder path
        return { error: 'click requires an element index or a target description' };
      }
      return { type: 'click', index: decision.index };
    case 'type':
      if (decision.index === undefined || !decision.text) return { error: 'type requires an index and text' };
      return { type: 'type', index: decision.index, text: decision.text };
    case 'scroll':
      return { type: 'scroll', direction: decision.direction ?? 'down' };
    case 'navigate':
      if (!decision.url) return { error: 'navigate requires a url' };
      return { type: 'navigate', url: decision.url };
    case 'back':
      return { type: 'back' };
    case 'done':
    case 'respond':
      return null;
  }
}
