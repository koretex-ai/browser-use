// Planner action-selection bench.
// Usage: node run.mjs [model ...]   (defaults to the full shortlist)
// Prompts are copied verbatim from
// extension/chrome-extension/src/background/agent/prompts.ts — keep in sync.

import { CASES } from './cases.mjs';

const BASE_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const TRIALS = 3;
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['qwen3.5:4b', 'qwen3.5:2b', 'granite4:3b', 'qwen3:4b'];

const PLANNER_SYSTEM_PROMPT = `You are a browser automation agent running locally in a Chrome side panel. You complete the user's task by choosing ONE action at a time against the current page.

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

function formatTurn(c) {
  const historyText = c.history.length ? c.history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none yet)';
  return `TASK: ${c.task}\n\nHISTORY:\n${historyText}\n\n${c.page}\n\nChoose the next action.`;
}

function parseJsonObject(content) {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`not JSON: ${content.slice(0, 80)}`);
  }
}

function matches(decision, accept) {
  return accept.some(a => {
    if (a.action !== decision.action) return false;
    if (a.index !== undefined && a.index !== decision.index) return false;
    if (a.direction !== undefined && a.direction !== decision.direction) return false;
    if (a.textIncludes && !(decision.text ?? '').toLowerCase().includes(a.textIncludes.toLowerCase())) return false;
    if (a.urlIncludes && !(decision.url ?? '').toLowerCase().includes(a.urlIncludes.toLowerCase())) return false;
    if (a.messageIncludes && !(decision.message ?? '').toLowerCase().includes(a.messageIncludes.toLowerCase()))
      return false;
    return true;
  });
}

async function callPlanner(model, turn) {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: turn },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return { content: data.message?.content ?? '', ms: Date.now() - started };
}

const results = [];
for (const model of MODELS) {
  process.stderr.write(`\n=== ${model} ===\n`);
  let pass = 0, total = 0, parseFailures = 0;
  const latencies = [];
  const failures = [];
  for (const c of CASES) {
    const turn = formatTurn(c);
    for (let trial = 0; trial < TRIALS; trial++) {
      total++;
      try {
        const { content, ms } = await callPlanner(model, turn);
        latencies.push(ms);
        const decision = parseJsonObject(content);
        if (matches(decision, c.accept)) {
          pass++;
        } else {
          failures.push({ case: c.id, trial, got: decision });
        }
      } catch (error) {
        parseFailures++;
        failures.push({ case: c.id, trial, error: String(error).slice(0, 120) });
      }
    }
    process.stderr.write('.');
  }
  latencies.sort((a, b) => a - b);
  const summary = {
    model,
    accuracy: +(pass / total * 100).toFixed(1),
    pass,
    total,
    parseFailures,
    medianMs: latencies[Math.floor(latencies.length / 2)] ?? null,
    p90Ms: latencies[Math.floor(latencies.length * 0.9)] ?? null,
    failures,
  };
  results.push(summary);
  process.stderr.write(
    `\n${model}: ${summary.accuracy}% (${pass}/${total}), parse failures ${parseFailures}, median ${summary.medianMs}ms\n`,
  );
}

console.log(JSON.stringify(results, null, 2));
