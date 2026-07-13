import type { PerceptionSnapshot } from '@extension/storage';

// Keep the planner input lean: prefill dominates latency on local models
const MAX_ELEMENTS = 120;
const MAX_ELEMENT_LABEL_CHARS = 80;
// Page-text budget in the planner observation. Local 4B models pay for every
// prefill token; escalated cloud planners can afford the full digest.
const LOCAL_PAGE_TEXT_CHARS = 1500;
const CLOUD_PAGE_TEXT_CHARS = 4000;

export const PLANNER_SYSTEM_PROMPT = `You are a browser automation agent running locally in a Chrome side panel. You complete the user's task by choosing ONE action at a time against the current page.

You will receive:
- TASK: what the user wants
- HISTORY: actions you already took and their results
- PAGE: the current URL, title, scroll position, and a numbered list of interactive elements
- TEXT: readable text on the page (truncated; viewport text first)

Choose exactly one action per turn:
- click: click element by index (e.g. links, buttons). If the element you need is clearly on the page but MISSING from the PAGE list (icon-only button, canvas UI), omit "index" and set "target" to a short visual description instead — a vision model will locate it on a screenshot.
- type: type text into an input element by index (this replaces its content)
- type_focused: type text into whatever currently has keyboard focus, as real keyboard input ("\n" makes a new line). Use for editors that are NOT in the PAGE list — canvas apps like Google Docs/Sheets — right after opening them or clicking into them.
- key: press a keyboard key on the focused element — set "combo" (e.g. "Enter" to submit a search box that has no button, "Escape" to close a dialog)
- extract: read information from the FULL page text (much more than the TEXT preview) — set "query" to exactly what you need (e.g. "token names with their % price changes"). The answer appears in HISTORY next turn. Use this to gather data instead of clicking into things.
- scroll: scroll the page up or down to reveal more elements
- navigate: go directly to a URL (fastest way to reach a known site)
- back: go back in browser history
- done: the task is complete — put your final answer for the user in "message"
- respond: the task needs no browser action at all (pure conversation) — leave message empty, a chat reply is generated separately

Reply ONLY with a JSON object of this exact shape (omit fields that do not apply):
{"reasoning": "<one short sentence>", "action": "click|type|type_focused|key|extract|scroll|navigate|back|done|respond", "index": <element index for click/type>, "target": "<visual description, ONLY for click when the element is not in the PAGE list>", "text": "<text for type/type_focused>", "combo": "<key for key, e.g. Enter>", "query": "<what to read, for extract>", "url": "<url for navigate>", "direction": "up|down for scroll", "message": "<final answer for done>"}

Rules:
- Only use element indices that appear in the PAGE list.
- After typing into a search box, submit it: click the search/submit button if one exists, otherwise press key "Enter". Typing alone never submits.
- To post, send or submit content you must FIRST type the content into the composer/input (type action), THEN click the post/send button. A disabled post/send button almost always means a required field is still empty — fill it; never click a disabled button twice.
- When the task asks you to FIND or READ information and the page likely contains it, use extract — do not scroll hunting for it or click into detail pages one by one.
- If the page does not contain what you need, scroll or navigate; do not invent elements.
- If an action failed twice, try a different approach. Never repeat an action HISTORY marks as failed or useless.
- Be decisive: finish in as few steps as possible. When the information the user asked for is visible in TEXT or HISTORY, use done and answer from it.
- Keep "reasoning" to one short sentence.`;

export function formatPageState(state: PerceptionSnapshot | null, pageTextChars = LOCAL_PAGE_TEXT_CHARS): string {
  if (!state) {
    return (
      'PAGE: (could not read this page this step — usually a TEMPORARY technical error while the page loads, ' +
      'not a website restriction. Do NOT navigate again and do NOT conclude the site is inaccessible; ' +
      'scroll to trigger a fresh read, or report the PERCEPTION ERROR from HISTORY via done.)'
    );
  }
  const elements = state.elements.slice(0, MAX_ELEMENTS).map(el => {
    const label = (el.text || el.placeholder || el.value || el.href || '').slice(0, MAX_ELEMENT_LABEL_CHARS);
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
  const truncated =
    state.elements.length > MAX_ELEMENTS ? `\n(+${state.elements.length - MAX_ELEMENTS} more below)` : '';
  const scrollInfo =
    state.scroll.pageHeight > state.scroll.viewportHeight
      ? ` | scroll ${state.scroll.y}/${state.scroll.pageHeight - state.scroll.viewportHeight}px`
      : '';
  const text = (state.pageText ?? '').slice(0, pageTextChars);
  const textSection = text ? `\n\nTEXT:\n${text}${(state.pageText ?? '').length > pageTextChars ? '…' : ''}` : '';
  return `PAGE: ${state.title} — ${state.url}${scrollInfo}\n${elements.join('\n')}${truncated}${textSection}`;
}

export function formatPlannerTurn(
  task: string,
  history: string[],
  state: PerceptionSnapshot | null,
  opts: { cloud?: boolean } = {},
): string {
  const historyText = history.length ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n') : '(none yet)';
  const pageTextChars = opts.cloud ? CLOUD_PAGE_TEXT_CHARS : LOCAL_PAGE_TEXT_CHARS;
  return `TASK: ${task}\n\nHISTORY:\n${historyText}\n\n${formatPageState(state, pageTextChars)}\n\nChoose the next action.`;
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
