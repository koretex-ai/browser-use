import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('orchestrator');

/**
 * Cloud orchestrator: a strong model that triages tasks, decomposes them into
 * subtasks for the local executor, checkpoints progress, and produces the
 * final validated answer.
 *
 * HARD RULE: payloads are digest-only. This module has no access to
 * screenshots or raw element lists by construction — only the task text,
 * plan state, and structured subtask outcome summaries cross the boundary.
 */

/**
 * One typed step of an orchestrator-authored program. The harness executes
 * steps deterministically — no local planner in between. Targets are element
 * DESCRIPTIONS (visible labels), resolved on-page by label matching with a
 * vision-grounding fallback.
 */
export interface ProgramStep {
  do:
    | 'navigate'
    | 'click'
    | 'type'
    | 'type_focused'
    | 'key'
    | 'scroll'
    | 'extract'
    | 'harvest'
    | 'verify_visual'
    | 'wait'
    | string;
  url?: string;
  target?: string;
  text?: string;
  combo?: string;
  query?: string;
  /** verify_visual: question answered from a screenshot by the local VLM */
  question?: string;
  /** harvest: stop once ~this many items are collected */
  until?: number;
  maxScrolls?: number;
  direction?: 'up' | 'down';
  times?: number;
  ms?: number;
}

export interface Subtask {
  goal: string;
  /** How the checkpoint judges whether this subtask succeeded */
  success: string;
  /**
   * The program: exact steps the harness executes deterministically. When
   * present, no local model interprets the goal. Omitted only for genuinely
   * open-ended work (a small local model then improvises — unreliable).
   */
  steps?: ProgramStep[];
  /**
   * Legacy: goal-only subtask that is exactly ONE browser action — the loop
   * performs the first successful action and stops. Superseded by steps.
   */
  atomic?: boolean;
}

export interface SubtaskOutcome {
  goal: string;
  status: 'ok' | 'fail';
  /** The local loop's final message or failure reason */
  summary: string;
  /** Last few action->result lines from the local loop */
  actions: string[];
  url?: string;
  title?: string;
  /**
   * Post-subtask page evidence for the checkpoint: interactive-element labels
   * (and optionally a page-text excerpt when the cloud-executor boundary is
   * open). Sent only for the most recent outcome to keep payloads lean.
   */
  evidence?: string[];
  pageTextExcerpt?: string;
}

export interface TriageResult {
  mode: 'chat' | 'execute' | 'plan';
  /** Direct answer for mode=chat */
  reply?: string;
  /** Ordered subtasks for mode=plan */
  subtasks?: Subtask[];
}

export interface CheckpointResult {
  decision: 'continue' | 'replan' | 'done' | 'fail';
  /** Final user-facing answer for decision=done */
  answer?: string;
  reason?: string;
  /** Remaining subtasks for decision=replan */
  subtasks?: Subtask[];
}

export interface RescueResult {
  decision: 'retry' | 'replan' | 'fail';
  /** Corrected, more concrete goal for decision=retry */
  revisedGoal?: string;
  revisedSuccess?: string;
  /** Corrected program for decision=retry — executed deterministically */
  steps?: ProgramStep[];
  reason?: string;
  /** Remaining subtasks for decision=replan */
  subtasks?: Subtask[];
}

// Shared step-forms reference for every prompt that authors programs
const STEP_FORMS = `Each subtask should include "steps": an exact program the browser runtime executes deterministically — no model interprets it, so put REAL values in. Step forms:
{"do":"navigate","url":"https://..."}
{"do":"click","target":"<visible label of the element, e.g. Start a post>"}
{"do":"type","target":"<label/placeholder of the input>","text":"..."}  (replaces the input's content)
{"do":"type_focused","text":"line1\\nline2"}  (trusted keyboard input into whatever has focus — the ONLY way to type into canvas editors like Google Docs/Sheets; they focus themselves when opened)
{"do":"key","combo":"Enter"}  (submit a search box after typing into it)
{"do":"scroll","direction":"down","times":2}
{"do":"extract","query":"<what to read from the page text>"}  (a local reader answers from page text; results accumulate in the task's data ledger)
{"do":"harvest","query":"<items to collect>","until":10}  (scroll+extract loop until ~N unique items are collected or results stop loading — USE THIS for any collect-N-things-from-a-feed work)
{"do":"verify_visual","question":"<yes/no question about what is visible on screen>"}  (a local vision model answers from a screenshot — the ONLY way to verify content inside canvas editors, since text extraction cannot see it; e.g. "Does the document body show a list titled 'Top 5 Voices'?")
{"do":"wait","ms":1500}
Targets are element DESCRIPTIONS (visible text labels), resolved on the live page by label matching with a vision fallback — never invent element indices. A step that fails stops the subtask and comes back to you with the page state. Omit "steps" (goal-only subtask) ONLY when the work genuinely needs on-page judgment; a small unreliable local model then improvises it — strongly prefer steps.

Canvas editors (Google Docs/Sheets): the editor is ALREADY FOCUSED when the document opens — go straight to type_focused. Never click menus, toolbars or mode buttons first (clicking steals focus and the keystrokes land in the wrong place); if UI state is uncertain, use {"do":"key","combo":"Escape"} before typing. Type PLAIN TEXT into documents — no markdown syntax like # or ** (WYSIWYG editors render it literally). End every canvas-write subtask with a verify_visual step that checks the typed content is visible in the document. NEVER put placeholder text (like "[to be filled]") in a typed step — compose the complete final text from the data you have; if the data is not collected yet, leave the subtask goal-only and compile it at a later checkpoint when the data exists.`;

const TRIAGE_SYSTEM_PROMPT = `You are the orchestrator for a browser agent that runs in a Chrome side panel. You compile the user's task into subtask PROGRAMS that a deterministic runtime executes against the user's active tab. Local models handle perception (locating described elements, reading page text) but do not make decisions. You never see the page yourself — plan from the task alone.

Classify the user's request and reply ONLY with a JSON object:
{"mode": "chat" | "execute" | "plan", "reply": "<answer for chat>", "subtasks": [{"goal": "...", "success": "...", "steps": [...]}]}

- "chat": no browser needed (questions, conversation). Leave "reply" empty — the answer is streamed by a separate call with full conversation history.
- "execute": ONE atomic browser action (e.g. "open site X"). Reply with a single subtask containing that one step.
- "plan": everything else. Decompose into 2-12 ordered subtasks. Group related steps into a subtask (e.g. one subtask = "search X and collect authors" with navigate+harvest steps); you are checkpointed after each subtask with evidence of the resulting page state.

${STEP_FORMS}

State each "success" criterion as an OBSERVABLE page fact (e.g. "the composer dialog is open", "the text 'hello world' appears in the editor"), never an intention. Example — "post hello world on LinkedIn" is one subtask with steps: navigate linkedin.com/feed → click "Start a post" → type "hello world" into "text editor" → click "Post". Use "type" (by target) for normal DOM inputs and editors; use "type_focused" only for canvas editors (Google Docs/Sheets) where the editing surface has no matchable label.

Rules: subtasks must be self-contained. The plan must COMPLETE the user's deliverable — if the task says to save/write/add/record something, the plan must include the subtask that actually writes it (and verifies it), not just open the destination. Prefer navigating directly to known URLs (including search-results URLs) over typing into search boxes; when you do type into a search box, the next step must be {"do":"key","combo":"Enter"}. Steps that submit or send content must come AFTER the step that enters the content. Never plan logging in, paying, or handling credentials — if the task requires it, note "requires the user to be signed in" in the goal.`;

const CHECKPOINT_SYSTEM_PROMPT = `You are the orchestrator for a browser agent. A small local executor just ran one subtask of your plan. You never see the page — judge from the structured outcomes.

Reply ONLY with a JSON object:
{"decision": "continue" | "replan" | "done" | "fail", "answer": "<final user answer for done>", "reason": "<short>", "subtasks": [{"goal": "...", "success": "...", "steps": [...]}]}

${STEP_FORMS}

- "continue": the plan is on track AND the remaining subtasks complete the user's full deliverable. If the remaining plan is missing the step that delivers (e.g. data was collected and the destination opened, but nothing writes the data), do NOT continue — replan to add it.
- "replan": the last outcome requires CHANGING COURSE. Provide the REMAINING subtasks (same format as planning, WITH "steps" programs) that replace the rest of the plan. Do NOT re-plan work the outcomes/evidence show is already done — e.g. a search already visited and harvested should not be searched again; move to the next untried approach or the next stage of the task. Replans are BUDGETED (a few per task): do not spend them polishing a plan that is working — if the remaining plan is reasonable, "continue" through it even when one outcome was mediocre. The moment DATA COLLECTED is sufficient for the user's deliverable, replan DIRECTLY to the deliverable subtasks (write/save/verify) — never schedule more collection than the task needs.
- "done": the user's TASK is fully accomplished. Write the final answer for the user in "answer", grounded ONLY in the outcome summaries and evidence — never invent facts that are not in them.
- "fail": the task cannot be completed (explain in "reason").

The most recent outcome includes "evidence": the interactive-element labels (and possibly a page text excerpt) captured AFTER it ran. Judge success against this evidence, not guesses — e.g. a closed composer dialog and a feed showing the posted text IS evidence the post succeeded.

You may also receive DATA COLLECTED SO FAR: information the agent extracted from pages earlier in this task. This survives even when the subtask that gathered it failed. When you replan subtasks that USE collected data (filling forms, spreadsheets, composing messages), paste the ACTUAL VALUES into the subtask goals — the executor cannot see the data any other way. When enough data is already collected, do not replan its re-collection.

RE-COMPILE DATA-WRITING SUBTASKS: when the NEXT pending subtask writes collected data (typing a list into a document, filling a form) and its steps do not already contain the complete, current, literal content — including when they were compiled earlier and the DATA COLLECTED has grown since, or they contain any placeholder text — respond "replan" and emit that subtask as a program whose type/type_focused step contains the COMPLETE literal text, composed by you from DATA COLLECTED SO FAR. Never leave a data-writing subtask for the small local model to improvise — it truncates long text.

CANVAS EDITORS ARE UNVERIFIABLE BY TEXT EXTRACTION: Google Docs/Sheets render content on a canvas, so page-text evidence CANNOT see what is inside the document — seeing only sidebar/placeholder text does NOT mean the document is empty. To verify a canvas write, use a {"do":"verify_visual","question":"..."} step — a local vision model reads the screenshot. When a type_focused step completed with correct focus discipline (Escape first, no menu clicks in between) and no visual verification is available, treat the write as successful with the caveat "content not verifiable by text extraction". NEVER re-type unless verify_visual gives POSITIVE evidence the content is absent — blind re-typing duplicates content.

IRREVERSIBLE-ACTION RULE: if a subtask may already have performed a side-effectful action (posting, sending, submitting a form, purchasing, deleting) and you are unsure whether it took effect, NEVER replan a repeat of that action. Issue a verification-only subtask instead (e.g. "check whether the post 'hello world' appears in the feed — do NOT create a new post"). Only if verification confirms it did not happen may the action be planned again.

Be strict: if an outcome does not actually contain the information or confirmation the task needs, do not declare done. When diagnosing a failure, state only causes the outcomes actually evidence — never guess at causes like "the user is not logged in" unless a summary says so. A disabled submit/post button means a required field was left empty, not a login problem.`;

const RESCUE_SYSTEM_PROMPT = `You are the orchestrator for a browser agent. The small local executor could not complete its goal: it either kept repeating an action with no effect on the page, or its actions kept failing. You get the goal it was pursuing, the actions it tried, and the interactive elements currently visible on the page (labels only — you cannot see the page itself). The executor can also "extract" — read information straight out of the page text — which usually beats clicking around for information-gathering goals. For canvas editors (Google Docs/Sheets) whose editing surface is NOT in the element list, direct it to use "type_focused": trusted keyboard input into the currently focused element (these editors focus themselves when opened).

You may also receive PREVIOUS RESCUE ATTEMPTS from this task and DATA COLLECTED SO FAR. Do not repeat a correction that already failed, and do not contradict a strategy that was making progress (e.g. if extracting authors from posts was yielding names, keep going down that path rather than reverting to an approach that returned nothing). If enough data is already collected, direct the executor to move on rather than re-collect.

Diagnose the real blocker and reply ONLY with a JSON object:
{"decision": "retry" | "replan" | "fail", "revisedGoal": "<corrected concrete goal>", "revisedSuccess": "<criterion>", "steps": [...], "reason": "<short diagnosis>", "subtasks": [{"goal": "...", "success": "...", "steps": [...]}]}

${STEP_FORMS}

- "retry": the goal was right but the approach was wrong. Provide corrected "steps" (a program, using the element labels you can see in the list) alongside the revisedGoal — the runtime executes them exactly, avoiding what was already tried.
- "replan": the plan itself is wrong from here. Provide the remaining subtasks with steps.
- "fail": the goal is impossible on this page (e.g. requires the user to be signed in).

Typical blockers to consider: a dialog needs a recipient/field filled first, the target is behind a menu, the wrong element was targeted, a disabled button's precondition is unmet, the page requires login.`;

// Tolerant JSON extraction (models sometimes wrap JSON in fences or prose)
function parseJsonObject<T>(content: string): T {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Orchestrator did not return JSON: ${content.slice(0, 120)}`);
  }
}

export async function isOrchestratorConfigured(): Promise<boolean> {
  const settings = await chatSettingsStore.getSettings();
  return Boolean(settings.orchestratorEnabled && settings.orchestratorApiKey && settings.orchestratorBaseUrl);
}

/** Attribution for one cloud call: model used and USD cost when reported */
export interface CallUsage {
  model: string;
  /** USD, when the provider reports it (OpenRouter usage accounting) */
  cost: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Per-role model selection: triage/checkpoint calls are frequent and easy —
 * they use the standard orchestrator model. Rescue, replan-under-failure and
 * salvage are rare and decide whether the whole run survives — they use the
 * strong model when one is configured.
 */
type OrchestratorRole = 'standard' | 'strong';

async function callOrchestrator<T>(
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
  role: OrchestratorRole = 'standard',
): Promise<{ value: T; usage: CallUsage }> {
  const { orchestratorBaseUrl, orchestratorApiKey, orchestratorModel, orchestratorModelStrong } =
    await chatSettingsStore.getSettings();
  const model = role === 'strong' && orchestratorModelStrong ? orchestratorModelStrong : orchestratorModel;

  const request = async (
    messages: { role: string; content: string }[],
  ): Promise<{ content: string; usage: CallUsage }> => {
    const response = await fetch(`${orchestratorBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${orchestratorApiKey}`,
        // OpenRouter attribution headers (ignored by other providers)
        'HTTP-Referer': 'https://github.com/koretex-ai/local-browser-use',
        'X-Title': 'Local Browser Use',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        // OpenRouter usage accounting: response.usage.cost in USD (ignored elsewhere)
        usage: { include: true },
      }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Orchestrator request failed (HTTP ${response.status}): ${detail}`);
    }
    const data = await response.json();
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    const content: string = data.choices?.[0]?.message?.content ?? '';
    logger.info('orchestrator response:', content.slice(0, 300));
    return {
      content,
      usage: {
        model: data.model ?? model,
        cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      },
    };
  };

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await request(messages);
  try {
    return { value: parseJsonObject<T>(first.content), usage: first.usage };
  } catch (parseError) {
    // One malformed reply is worth a retry, not a dead task
    logger.warning('orchestrator returned non-JSON, retrying once:', parseError);
    const retry = await request([
      ...messages,
      { role: 'assistant', content: first.content.slice(0, 2000) },
      {
        role: 'user',
        content:
          'That was not valid JSON. Reply ONLY with the JSON object in the specified format — no prose, no code fences.',
      },
    ]);
    const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
    const usage: CallUsage = {
      model: retry.usage.model,
      cost: sum(first.usage.cost, retry.usage.cost),
      promptTokens: sum(first.usage.promptTokens, retry.usage.promptTokens),
      completionTokens: sum(first.usage.completionTokens, retry.usage.completionTokens),
    };
    return { value: parseJsonObject<T>(retry.content), usage };
  }
}

export async function triageTask(
  task: string,
  signal: AbortSignal,
): Promise<{ result: TriageResult; usage: CallUsage }> {
  const { value: result, usage } = await callOrchestrator<TriageResult>(
    TRIAGE_SYSTEM_PROMPT,
    `TASK: ${task}`,
    signal,
  );
  if (!['chat', 'execute', 'plan'].includes(result.mode)) {
    throw new Error(`Orchestrator returned invalid mode: ${String(result.mode)}`);
  }
  if (result.mode === 'plan' && (!Array.isArray(result.subtasks) || result.subtasks.length === 0)) {
    // A plan with no subtasks degrades to direct execution
    return { result: { mode: 'execute' }, usage };
  }
  return { result, usage };
}

export interface StuckDigest {
  goal: string;
  actions: string[];
  /** Labels of interactive elements currently on the page ("[i]<tag> label") */
  elements: string[];
  url?: string;
  title?: string;
  /** What earlier rescues in this task decided (so corrections don't thrash) */
  priorRescues?: string[];
  /** Data extracted so far in this task */
  ledger?: string[];
}

function ledgerSection(ledger?: string[]): string {
  return ledger?.length ? `\n\nDATA COLLECTED SO FAR:\n${ledger.slice(-10).join('\n')}` : '';
}

// Mid-subtask rescue: the executor is looping; ask for a corrected goal.
// The digest widens the boundary to element LABELS (text), never pixels.
// Diagnosis escalates like execution does: the first rescue uses the standard
// orchestrator model; later rescues (the first correction already failed) use
// the strong model.
export async function rescueSubtask(
  task: string,
  stuck: StuckDigest,
  signal: AbortSignal,
  useStrongModel = false,
): Promise<{ result: RescueResult; usage: CallUsage }> {
  const priorRescues = stuck.priorRescues?.length
    ? `\n\nPREVIOUS RESCUE ATTEMPTS:\n${stuck.priorRescues.join('\n')}`
    : '';
  const userContent =
    `TASK: ${task}\n\nSTUCK SUBTASK GOAL: ${stuck.goal}\n\n` +
    `PAGE: ${stuck.title ?? ''} — ${stuck.url ?? ''}\n` +
    `ACTIONS TRIED:\n${stuck.actions.join('\n') || '(none)'}\n\n` +
    `INTERACTIVE ELEMENTS ON PAGE:\n${stuck.elements.slice(0, 60).join('\n')}` +
    priorRescues +
    ledgerSection(stuck.ledger);
  const { value: result, usage } = await callOrchestrator<RescueResult>(
    RESCUE_SYSTEM_PROMPT,
    userContent,
    signal,
    useStrongModel ? 'strong' : 'standard',
  );
  if (!['retry', 'replan', 'fail'].includes(result.decision)) {
    throw new Error(`Orchestrator returned invalid rescue decision: ${String(result.decision)}`);
  }
  return { result, usage };
}

export async function checkpoint(
  task: string,
  plan: Subtask[],
  outcomes: SubtaskOutcome[],
  signal: AbortSignal,
  ledger?: string[],
): Promise<{ result: CheckpointResult; usage: CallUsage }> {
  const userContent =
    `TASK: ${task}\n\n` +
    `PLAN:\n${plan.map((s, i) => `${i + 1}. ${s.goal} (success: ${s.success})`).join('\n')}\n\n` +
    `OUTCOMES SO FAR (JSON):\n${JSON.stringify(outcomes, null, 1)}` +
    ledgerSection(ledger);
  const { value: result, usage } = await callOrchestrator<CheckpointResult>(
    CHECKPOINT_SYSTEM_PROMPT,
    userContent,
    signal,
  );
  if (!['continue', 'replan', 'done', 'fail'].includes(result.decision)) {
    throw new Error(`Orchestrator returned invalid decision: ${String(result.decision)}`);
  }
  return { result, usage };
}

const SALVAGE_SYSTEM_PROMPT = `You are the orchestrator for a browser agent. The run is out of budget and CANNOT continue, but some subtasks produced real information along the way. Write the best possible partial answer for the user from the outcome summaries.

Reply ONLY with a JSON object: {"answer": "<partial answer>"}

Rules: ground every fact ONLY in the outcome summaries — never invent data. Lead with what WAS found, then say briefly what could not be completed. If the outcomes contain no useful information at all, say so honestly in one sentence.`;

/**
 * Budget exhausted — turn the trajectory into the best partial answer instead
 * of a bare failure. Uses the strong model: it is the last call of the run.
 */
export async function salvageAnswer(
  task: string,
  outcomes: SubtaskOutcome[],
  signal: AbortSignal,
  ledger?: string[],
): Promise<{ answer: string; usage: CallUsage }> {
  const userContent =
    `TASK: ${task}\n\nOUTCOMES (JSON):\n${JSON.stringify(outcomes, null, 1)}` + ledgerSection(ledger);
  const { value, usage } = await callOrchestrator<{ answer: string }>(
    SALVAGE_SYSTEM_PROMPT,
    userContent,
    signal,
    'strong',
  );
  if (!value.answer) throw new Error('Salvage returned no answer');
  return { answer: value.answer, usage };
}
