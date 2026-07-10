import type { PerceptionSnapshot } from '@extension/storage';

// Keep the planner input lean: prefill dominates latency on local models
const MAX_ELEMENTS = 120;
const MAX_ELEMENT_LABEL_CHARS = 80;

export const PLANNER_SYSTEM_PROMPT = `You are a browser automation agent running locally in a Chrome side panel. You complete the user's task by choosing ONE action at a time against the current page.

You will receive:
- TASK: what the user wants
- HISTORY: actions you already took and their results
- PAGE: the current URL, title, scroll position, and a numbered list of interactive elements

Choose exactly one action per turn:
- click: click element by index (e.g. links, buttons)
- type: type text into an input element by index (this replaces its content)
- scroll: scroll the page up or down to reveal more elements
- navigate: go directly to a URL (fastest way to reach a known site)
- back: go back in browser history
- done: the task is complete — put your final answer for the user in "message"
- respond: the task needs no browser action at all (pure conversation) — leave message empty, a chat reply is generated separately

Reply ONLY with a JSON object of this exact shape (omit fields that do not apply):
{"reasoning": "<one short sentence>", "action": "click|type|scroll|navigate|back|done|respond", "index": <element index for click/type>, "text": "<text for type>", "url": "<url for navigate>", "direction": "up|down for scroll", "message": "<final answer for done>"}

Rules:
- Only use element indices that appear in the PAGE list.
- After typing into a search box, click the search/submit button (or a suggestion) to submit.
- If the page does not contain what you need, scroll or navigate; do not invent elements.
- If an action failed twice, try a different approach.
- Be decisive: finish in as few steps as possible. When the information the user asked for is visible in the PAGE list, use done and answer from it.
- Keep "reasoning" to one short sentence.`;

export function formatPageState(state: PerceptionSnapshot | null): string {
  if (!state) {
    return 'PAGE: (no access to this page — it may be a chrome:// or restricted page; navigate somewhere else)';
  }
  const elements = state.elements.slice(0, MAX_ELEMENTS).map(el => {
    const label = (el.text || el.placeholder || el.value || el.href || '').slice(0, MAX_ELEMENT_LABEL_CHARS);
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
  const truncated = state.elements.length > MAX_ELEMENTS ? `\n(+${state.elements.length - MAX_ELEMENTS} more below)` : '';
  const scrollInfo =
    state.scroll.pageHeight > state.scroll.viewportHeight
      ? ` | scroll ${state.scroll.y}/${state.scroll.pageHeight - state.scroll.viewportHeight}px`
      : '';
  return `PAGE: ${state.title} — ${state.url}${scrollInfo}\n${elements.join('\n')}${truncated}`;
}

export function formatPlannerTurn(task: string, history: string[], state: PerceptionSnapshot | null): string {
  const historyText = history.length ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n') : '(none yet)';
  return `TASK: ${task}\n\nHISTORY:\n${historyText}\n\n${formatPageState(state)}\n\nChoose the next action.`;
}

export const VALIDATOR_SYSTEM_PROMPT = `You are a strict validator for a browser automation agent. Given the user's TASK, the agent's ACTIONS, its proposed final ANSWER, and the final PAGE state, decide whether the task is genuinely complete and the answer is grounded in what happened. Respond with valid=false and a short reason if the agent gave up early, hallucinated, or the page state contradicts the answer.

Reply ONLY with a JSON object: {"valid": true|false, "reason": "<short reason if invalid, else empty>"}`;

export function formatValidatorTurn(
  task: string,
  history: string[],
  answer: string,
  state: PerceptionSnapshot | null,
): string {
  return `TASK: ${task}\n\nACTIONS:\n${history.join('\n') || '(none)'}\n\nANSWER: ${answer}\n\n${formatPageState(state)}`;
}
