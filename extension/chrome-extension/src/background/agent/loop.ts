import type { PerceptionSnapshot, TaskRecord, RecipeRecord } from '@extension/storage';
import { Actors, chatSettingsStore, trajectoryStore, recipeStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState, capturePageText, clearHighlights } from '../perception';
import { executeAction } from '../actions/executor';
import { detachCdp } from '../actions/cdp';
import { streamChatReply, streamCloudChatReply } from './chat';
import { groundTarget } from './grounder';
import { planNextAction, validateCompletion, decisionToAction, extractFromPage, LOCAL_ENDPOINT } from './planner';
import type { PlannerDecision, PlannerEndpoint } from './planner';
import { PLANNER_SYSTEM_PROMPT, VALIDATOR_SYSTEM_PROMPT, formatPlannerTurn, formatValidatorTurn } from './prompts';
import { isOrchestratorConfigured, triageTask, checkpoint, rescueSubtask, salvageAnswer } from './orchestrator';
import type { Subtask, SubtaskOutcome, CallUsage, ProgramStep } from './orchestrator';
import { runProgramSubtask } from './program';
import { recipeLibraryDigest, instantiateRecipe, parameterizeSubtask, saveRecipeCandidate } from './recipes';

const logger = createLogger('agent');

const MAX_STEPS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;
// Validate at most once: a 4B validator that rejects twice is more likely
// wrong than the planner; don't burn the step budget arguing
const MAX_VALIDATION_REJECTIONS = 1;
// A decision repeated this many times (or a page unchanged across this many
// steps) means the executor is looping — warn once, then declare stuck
const STUCK_REPEAT_THRESHOLD = 3;
// Orchestrated-mode budgets. Subtasks are action-granular (one concrete
// action each), so a normal task needs more of them than the old coarse plans
const MAX_SUBTASKS = 12;
// In the compiler architecture replans are routine steering (~$0.003 each),
// not failure recovery — budget for a couple of strategy tweaks AND the
// final pivot to the deliverable
const MAX_REPLANS = 4;
// Evidence caps for checkpoint outcome digests
const MAX_EVIDENCE_TEXT_CHARS = 800;
// Three rescues per subtask, cheapest capability first: rescue 1 retries the
// LOCAL model with the orchestrator's corrected goal (better instructions are
// free); only if that fails do rescues 2 and 3 escalate to the tier-1 and
// tier-2 cloud executors. Cloud models are for orchestration and last-resort
// execution, not the default hands.
const MAX_RESCUES_PER_SUBTASK = 3;
// How much of an extract answer flows back into the planner HISTORY
const MAX_EXTRACT_HISTORY_CHARS = 600;
// Extracts are the slowest local operation (~16k-char prefill + long
// generation on a 4B model) — cap them per subtask so redundant re-reads
// can't eat the wall clock
const MAX_EXTRACTS_PER_SUBTASK = 4;

// Fuzzy comparison for extract stagnation: strip digits so changing
// like/view counts can't disguise otherwise-identical content
function normalizeExtract(answer: string): string {
  return answer.toLowerCase().replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim();
}

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  return `☁ ${usage.model} · ${cost}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizable(decision: any): string {
  switch (decision.action) {
    case 'click':
      return decision.index !== undefined ? `click [${decision.index}]` : `click "${decision.target}"`;
    case 'type':
      return `type "${decision.text}" into [${decision.index}]`;
    case 'type_focused':
      return `type "${(decision.text ?? '').slice(0, 60)}" into the focused editor`;
    case 'key':
      return `press ${decision.combo}`;
    case 'extract':
      return `extract "${decision.query}"`;
    case 'scroll':
      return `scroll ${decision.direction ?? 'down'}`;
    case 'navigate':
      return `navigate to ${decision.url}`;
    case 'back':
      return 'go back';
    default:
      return decision.action;
  }
}

function decisionKey(decision: PlannerDecision): string {
  return JSON.stringify([
    decision.action,
    decision.index,
    decision.target,
    decision.text,
    decision.url,
    decision.direction,
    decision.query,
    decision.combo,
  ]);
}

function pageSignature(state: PerceptionSnapshot | null): string {
  if (!state) return 'no-state';
  return `${state.url}|${state.scroll.y}|${state.elements.length}|${state.elements
    .map(el => el.text)
    .join(',')
    .slice(0, 400)}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 60).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

export interface SubtaskRunResult {
  status: 'ok' | 'fail' | 'stuck' | 'streamed';
  summary: string;
  actions: string[];
  url?: string;
  title?: string;
  /** Element labels from the final page state (rescue input + checkpoint evidence) */
  elementsDigest?: string[];
  /** Short excerpt of the final page text (checkpoint evidence, boundary-gated) */
  pageTextExcerpt?: string;
}

interface SubtaskOptions {
  /** TaskRecord this subtask belongs to */
  taskRecordId: string;
  /** Success criterion (recorded; also appended to the goal by callers) */
  success?: string;
  plannedBy: 'orchestrator' | 'user';
  /** Run the local 4B validator on 'done' (local-only mode; checkpoints cover it in hybrid) */
  useLocalValidator: boolean;
  /** Allow a 'respond' decision to fall through to streaming chat (top-level tasks only) */
  allowRespondChat: boolean;
  /** Prefix for step narration, e.g. "[2/4] " */
  stepPrefix?: string;
  /**
   * Which model drives this subtask. Local by default; after a stuck-rescue
   * the caller escalates to a cloud endpoint (text-only observation — element
   * labels and page text, never screenshots; grounding stays local).
   */
  endpoint?: PlannerEndpoint;
  /**
   * NOTE lines seeded into HISTORY before the first step: approaches that
   * already failed earlier in this task, so the planner does not repeat them.
   */
  seedHistory?: string[];
  /** Cost attribution for escalated planner calls; returns the display meta */
  trackUsage?: (usage: CallUsage) => string;
  /**
   * The goal is exactly ONE browser action (orchestrator-tagged): perform the
   * first successful action and stop — no room for a small model to improvise.
   */
  atomic?: boolean;
  /** Receives every extract result, for the task-level data ledger */
  onExtract?: (query: string, answer: string) => void;
  /** Live view of already-collected data, so extracts report only NEW items */
  knownData?: () => string[];
}

/**
 * The inner loop: perceive → plan → execute against one bounded goal.
 * Detects decision loops and no-effect streaks (warn once, then 'stuck').
 * Returns a structured outcome and writes a SubtaskRecord; posts step
 * narration but no terminal events — callers decide how the task ends.
 */
async function runSubtask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  goal: string,
  opts: SubtaskOptions,
  signal: AbortSignal,
): Promise<SubtaskRunResult> {
  const subtaskId = crypto.randomUUID();
  const startedAt = Date.now();
  const history: string[] = [...(opts.seedHistory ?? [])];
  const prefix = opts.stepPrefix ?? '';
  let consecutiveFailures = 0;
  let validationRejections = 0;
  let stepsCount = 0;
  let lastState: PerceptionSnapshot | null = null;
  // Loop detection
  let repeatKey = '';
  let repeatCount = 0;
  let lastSignature = '';
  let sameSignatureStreak = 0;
  let loopWarned = false;
  // Extract stagnation: the same answer twice means no new information, even
  // if the query was reworded (digits stripped so engagement counts don't
  // disguise identical content)
  let lastExtractAnswer = '';
  let extractCount = 0;
  // Consecutive perception failures: fail loudly with the REAL error instead
  // of letting the model confabulate "the site is inaccessible"
  let perceptionFailures = 0;
  const MAX_PERCEPTION_FAILURES = 3;

  const { model: localModel, grounderModel } = await chatSettingsStore.getSettings();
  const endpoint = opts.endpoint ?? LOCAL_ENDPOINT;
  const isCloud = endpoint.kind === 'cloud';
  const plannerModelName = isCloud ? endpoint.model : localModel;
  const plannerTier = isCloud ? endpoint.tier : 0;
  const plannerMeta = isCloud ? `☁ ${endpoint.model} (escalated)` : `⌂ ${localModel} (local) · $0`;
  const grounderMeta = `⌂ ${grounderModel.split('/').pop()} (local) · $0`;

  const finalize = async (status: 'ok' | 'fail' | 'stuck', summary: string): Promise<SubtaskRunResult> => {
    // Evidence must reflect the page AFTER the subtask's last action: the
    // step-top snapshot predates it (an atomic navigate would otherwise ship
    // the PREVIOUS page as evidence and mislead the checkpoint)
    const finalState = await capturePageState(tabId, false).catch(() => lastState);
    if (finalState) lastState = finalState;
    await trajectoryStore
      .appendSubtask({
        id: subtaskId,
        sessionId: taskId,
        taskRecordId: opts.taskRecordId,
        goal,
        success: opts.success ?? '',
        status,
        summary,
        stepsCount,
        plannedBy: opts.plannedBy,
        plannerTier,
        plannerModel: plannerModelName,
        startedAt,
        endedAt: Date.now(),
      })
      .catch(error => logger.warning('subtask record failed:', error));
    return {
      status,
      summary,
      actions: history.slice(-6),
      url: lastState?.url,
      title: lastState?.title,
      // Final page state: rescue input on failure, checkpoint evidence always
      // (the checkpoint judges success against what the page actually shows)
      elementsDigest: elementsDigestOf(lastState),
      pageTextExcerpt: lastState?.pageText?.slice(0, MAX_EVIDENCE_TEXT_CHARS),
    };
  };

  const logRejectedDecision = (decision: PlannerDecision, error: string) => {
    if (!lastState) return;
    trajectoryStore
      .appendStep({
        sessionId: taskId,
        before: lastState,
        action: null,
        ok: false,
        error,
        timestamp: Date.now(),
        subtaskId,
        decision,
        plannerModel: plannerModelName,
        plannerTier,
        historyContext: history.slice(-8),
      })
      .catch(err => logger.warning('trajectory logging failed:', err));
  };

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      // Perception with one delayed retry: transient failures happen while a
      // page is mid-navigation, and the retry usually lands after it settles
      let perceptionError = '';
      const state: PerceptionSnapshot | null = await capturePageState(tabId, true).catch(async error => {
        logger.warning('perception failed, retrying:', error);
        await new Promise(resolve => setTimeout(resolve, 1500));
        return capturePageState(tabId, true).catch(retryError => {
          perceptionError = retryError instanceof Error ? retryError.message : String(retryError);
          logger.warning('perception retry failed:', perceptionError);
          return null;
        });
      });
      lastState = state ?? lastState;
      if (state) {
        perceptionFailures = 0;
      } else {
        perceptionFailures++;
        history.push(
          `PERCEPTION ERROR (a temporary technical problem reading the page — NOT a website restriction): ${perceptionError.slice(0, 150)}`,
        );
        if (perceptionFailures >= MAX_PERCEPTION_FAILURES) {
          await clearHighlights(tabId).catch(() => {});
          return await finalize(
            'fail',
            `Perception failed ${MAX_PERCEPTION_FAILURES} times in a row (${perceptionError.slice(0, 200)}). ` +
              'This is a tooling problem (page still loading, or extension site access), not a website restriction — do not conclude the site is inaccessible.',
          );
        }
      }

      // No-effect detection: the page has not changed across executed steps
      const signature = pageSignature(state);
      if (signature === lastSignature) sameSignatureStreak++;
      else {
        sameSignatureStreak = 0;
        lastSignature = signature;
      }

      // A malformed planner response is a failed step, not a dead task: small
      // models occasionally emit broken JSON; strike it and re-plan (three
      // strikes still end the subtask, which now leads to rescue/escalation)
      let planned;
      try {
        planned = await planNextAction(
          PLANNER_SYSTEM_PROMPT,
          formatPlannerTurn(goal, history, state, { cloud: isCloud }),
          signal,
          endpoint,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('planner call failed:', message);
        history.push(`planner error -> ${message.slice(0, 120)} (produce ONLY the JSON object)`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }
      const { decision, usage: planUsage } = planned;
      const stepMeta = planUsage ? (opts.trackUsage?.(planUsage) ?? cloudMeta(planUsage)) : plannerMeta;
      logger.info(`${prefix}step ${step}:`, JSON.stringify(decision));
      stepsCount++;

      // Repeated-decision detection
      const key = decisionKey(decision);
      if (key === repeatKey) repeatCount++;
      else {
        repeatKey = key;
        repeatCount = 1;
      }
      const isTerminal = decision.action === 'done' || decision.action === 'respond';
      if (!isTerminal && (repeatCount >= STUCK_REPEAT_THRESHOLD || sameSignatureStreak >= STUCK_REPEAT_THRESHOLD)) {
        if (!loopWarned) {
          loopWarned = true;
          repeatCount = 0;
          logRejectedDecision(decision, 'suppressed: repeated action with no page change');
          history.push(
            'NOTE: you are repeating the same action and the page is NOT changing. That approach does not work. ' +
              'Choose something DIFFERENT: another element, extract, scroll, navigate, or report the blocker via done.',
          );
          continue;
        }
        logRejectedDecision(decision, 'stuck: repeated action with no page change after warning');
        await clearHighlights(tabId).catch(() => {});
        return await finalize(
          'stuck',
          `Looping without progress: repeated "${summarizable(decision)}" with no page change. Last steps:\n${history
            .slice(-4)
            .join('\n')}`,
        );
      }

      if (decision.action === 'respond') {
        if (opts.allowRespondChat) {
          await clearHighlights(tabId).catch(() => {});
          await streamChatReply(port, taskId, goal, signal);
          return await finalize('ok', '(answered conversationally)').then(r => ({ ...r, status: 'streamed' as const }));
        }
        // Inside a plan, 'respond' means: nothing to do in the browser
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', decision.message || 'No browser action was needed for this subtask.');
      }

      if (decision.action === 'done') {
        const answer = decision.message || 'Subtask complete.';
        if (opts.useLocalValidator && validationRejections < MAX_VALIDATION_REJECTIONS && history.length > 0) {
          const verdict = await validateCompletion(
            VALIDATOR_SYSTEM_PROMPT,
            formatValidatorTurn(goal, history, answer, state),
            signal,
          ).catch(error => {
            logger.warning('validator failed, accepting answer:', error);
            return { valid: true, reason: '' };
          });
          if (!verdict.valid) {
            validationRejections++;
            history.push(`done rejected by validator: ${verdict.reason}`);
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `Validator: not done — ${verdict.reason}`,
              plannerMeta,
            );
            continue;
          }
        }
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', answer);
      }

      // The extract action: answer the planner's query from the full page
      // text with a dedicated LLM call, then feed the answer back via HISTORY
      if (decision.action === 'extract' && decision.query) {
        const query = decision.query;
        extractCount++;
        if (extractCount > MAX_EXTRACTS_PER_SUBTASK) {
          // Skip the expensive LLM call entirely — the budget is spent
          sameSignatureStreak++;
          history.push(
            `extract "${query}" -> SKIPPED: the extract budget for this subtask (${MAX_EXTRACTS_PER_SUBTASK}) is used up. ` +
              'Scroll or navigate to change the page, or finish with done.',
          );
          continue;
        }
        try {
          const pageText = await capturePageText(tabId).catch(() => state?.pageText ?? '');
          const { answer, usage } = await extractFromPage(query, pageText, signal, endpoint, opts.knownData?.() ?? []);
          if (usage) opts.trackUsage?.(usage);
          const found = !answer.startsWith('NOT FOUND');
          const nothingNew = /^NOTHING NEW/i.test(answer);
          const stagnant =
            nothingNew || (normalizeExtract(answer) === lastExtractAnswer && normalizeExtract(answer) !== '');
          lastExtractAnswer = normalizeExtract(answer);
          if (stagnant) {
            // Same answer as last time: no new information was gained. Count
            // it toward the stuck streak instead of resetting it, and tell
            // the planner to stop re-extracting.
            sameSignatureStreak++;
            history.push(
              `extract "${query}" -> ${nothingNew ? 'NOTHING NEW beyond already-collected data' : 'SAME ANSWER as the previous extract'} — no new information. ` +
                'Do NOT extract again without changing the page first (scroll or navigate), or finish with done.',
            );
            continue;
          }
          if (found && opts.onExtract) opts.onExtract(query, answer);
          if (opts.atomic && found) {
            await clearHighlights(tabId).catch(() => {});
            return await finalize('ok', `extract "${query}" -> ${answer.slice(0, MAX_EXTRACT_HISTORY_CHARS)}`);
          }
          // Extraction gains information without changing the page — don't
          // let the no-effect detector count it as a stuck streak
          sameSignatureStreak = 0;
          history.push(`extract "${query}" -> ${answer.slice(0, MAX_EXTRACT_HISTORY_CHARS)}`);
          postExecutionEvent(
            port,
            Actors.SYSTEM,
            'step.ok',
            taskId,
            `${prefix}Step ${step}: extract "${query}" — ${answer.slice(0, 200)}${answer.length > 200 ? '…' : ''}`,
            stepMeta,
          );
          if (state) {
            trajectoryStore
              .appendStep({
                sessionId: taskId,
                before: state,
                action: { type: 'extract', query },
                ok: found,
                error: found ? undefined : answer.slice(0, 200),
                timestamp: Date.now(),
                subtaskId,
                decision,
                plannerModel: plannerModelName,
                plannerTier,
                historyContext: history.slice(-8),
              })
              .catch(err => logger.warning('trajectory logging failed:', err));
          }
          consecutiveFailures = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          history.push(`extract "${query}" -> FAILED: ${message}`);
          consecutiveFailures++;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      const logContext = {
        subtaskId,
        decision,
        plannerModel: plannerModelName,
        plannerTier,
        historyContext: history.slice(-8),
      };

      // Hybrid grounding: click-by-target routes through the vision grounder
      if (decision.action === 'click' && decision.index === undefined && decision.target) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${prefix}Step ${step}: locating "${decision.target}" visually — ${decision.reasoning}`,
          grounderMeta,
        );
        // Highlights would pollute the grounder's screenshot
        await clearHighlights(tabId).catch(() => {});
        try {
          const point = await groundTarget(tabId, decision.target, signal);
          const result = await executeAction(
            tabId,
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
            logContext,
          );
          history.push(`ground+click "${decision.target}" -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);
          if (opts.atomic && result.ok) {
            return await finalize('ok', `Performed: ground+click "${decision.target}" — ${result.message}`);
          }
          consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          history.push(`ground "${decision.target}" -> FAILED: ${message}`);
          consecutiveFailures++;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      const action = decisionToAction(decision);
      if (action === null) continue; // unreachable, satisfies types
      if ('error' in action) {
        logRejectedDecision(decision, action.error);
        history.push(`invalid decision (${summarizable(decision)}): ${action.error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      // Reject hallucinated indices before executing: the planner must pick
      // from the PAGE list it was shown
      if ((action.type === 'click' || action.type === 'type') && state && action.index >= state.elements.length) {
        const error =
          `index ${action.index} is not in the PAGE list ` +
          `(it has ${state.elements.length} elements, [0]..[${state.elements.length - 1}])`;
        logRejectedDecision(decision, error);
        history.push(`${summarizable(decision)} -> REJECTED: ${error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `${prefix}Step ${step}: ${summarizable(decision)} — ${decision.reasoning}`,
        stepMeta,
      );

      const result = await executeAction(tabId, taskId, action, state, logContext);
      history.push(`${summarizable(decision)} -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);

      // Atomic subtask: the one action succeeded — stop here, leaving the
      // small model no leftover budget to improvise with
      if (opts.atomic && result.ok) {
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', `Performed: ${summarizable(decision)} — ${result.message}`);
      }

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    await clearHighlights(tabId).catch(() => {});
    return await finalize(
      'fail',
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last steps:\n${history.slice(-3).join('\n')}`
        : `Step budget (${MAX_STEPS}) exhausted without completing: ${goal}`,
    );
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    throw error;
  }
}

/** Local-only mode: the original single-level agent loop. */
async function runLocalTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  record.mode = 'local';
  const outcome = await runSubtask(
    port,
    tabId,
    taskId,
    task,
    { taskRecordId: record.id, plannedBy: 'user', useLocalValidator: true, allowRespondChat: true },
    signal,
  );
  if (outcome.status === 'streamed') {
    record.outcome = 'ok';
    return; // chat path posted its own events
  }
  const meta = `⌂ ${record.localModel} (local) · task total $0`;
  if (outcome.status === 'ok') {
    record.outcome = 'ok';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, outcome.summary, meta);
  } else {
    record.outcome = 'fail';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, outcome.summary, meta);
  }
}

/** Hybrid mode: cloud orchestrator plans, checkpoints, and rescues; local models execute. */
async function runOrchestratedTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  const settings = await chatSettingsStore.getSettings();
  let costKnown = true;
  const track = (usage: CallUsage): string => {
    record.cloudCalls++;
    record.orchestratorModel = usage.model;
    if (usage.cost !== null) record.totalCostUsd += usage.cost;
    else costKnown = false;
    return cloudMeta(usage);
  };
  const totalMeta = () =>
    `task total ${costKnown ? '' : '≥'}$${record.totalCostUsd.toFixed(4)} · ${record.cloudCalls} cloud call${record.cloudCalls === 1 ? '' : 's'}`;

  const finishOk = (answer: string, meta: string) => {
    record.outcome = 'ok';
    record.answer = answer;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, answer, `${meta} · ${totalMeta()}`);
  };
  const finishFail = (reason: string, meta: string) => {
    record.outcome = 'fail';
    record.answer = reason;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, reason, `${meta} · ${totalMeta()}`);
  };

  // Budget exhausted — salvage the best partial answer from the outcomes
  // instead of reporting a bare failure
  const outcomes: SubtaskOutcome[] = [];
  const finishWithSalvage = async (reason: string, meta: string) => {
    const useful = ledger.length > 0 || outcomes.some(o => o.status === 'ok' || o.summary.length > 40);
    if (!useful) {
      finishFail(reason, meta);
      return;
    }
    // Even a failed run may have VERIFIED reusable site lore along the way
    // (e.g. a working filtered-search URL) — bank the succeeded programs as a
    // partial recipe before salvaging the answer
    await maybeSaveRecipe();
    try {
      const { answer, usage } = await salvageAnswer(task, leanOutcomes(outcomes), signal, ledger);
      finishFail(`${answer}\n\n(${reason})`, track(usage));
    } catch (error) {
      logger.warning('salvage failed:', error);
      finishFail(reason, meta);
    }
  };

  // Escalation ladder for the executor planner: local → tier-1 cloud → tier-2
  // cloud. Text-only by construction: the cloud planner receives element
  // labels and page text, never screenshots (grounding stays local).
  const escalationEndpoint = (tier: number): Extract<PlannerEndpoint, { kind: 'cloud' }> | undefined => {
    if (tier < 1 || !settings.cloudExecutorEnabled || !settings.orchestratorApiKey) return undefined;
    const model = tier >= 2 && settings.executorModelTier2 ? settings.executorModelTier2 : settings.executorModelTier1;
    if (!model) return undefined;
    return {
      kind: 'cloud',
      baseUrl: settings.orchestratorBaseUrl,
      apiKey: settings.orchestratorApiKey,
      model,
      tier: Math.min(tier, 2),
    };
  };

  // Task-level data ledger: everything extracted from pages survives here
  // even when the subtask that gathered it failed. Flows into checkpoints,
  // rescues, salvage, and (as seed notes) into later subtasks.
  const ledger: string[] = [];
  const recordExtract = (query: string, answer: string) => {
    ledger.push(`${query} -> ${answer.replace(/\n/g, ' ').slice(0, 700)}`);
  };
  // What each rescue decided, so later rescues don't thrash between strategies
  const rescueLog: string[] = [];

  // Cross-subtask failure memory: approaches that already failed in this
  // task, seeded into each new subtask's HISTORY so they are not repeated
  const failureMemory: string[] = [];
  const rememberFailure = (goal: string, run: SubtaskRunResult) => {
    if (run.status === 'ok' || run.status === 'streamed') return;
    failureMemory.push(
      `NOTE: earlier in this task, the approach "${goal.slice(0, 100)}" ${run.status === 'stuck' ? 'got stuck' : 'failed'}: ${run.summary
        .replace(/\n/g, ' ')
        .slice(0, 160)}. Do not repeat it.`,
    );
  };

  // Run one subtask with stuck-rescue: on 'stuck', ask the orchestrator for a
  // corrected goal and retry with an ESCALATED executor (each rescue moves up
  // a tier) before reporting the outcome
  const runWithRescue = async (
    subtask: Subtask,
    stepPrefix: string,
  ): Promise<{
    run: SubtaskRunResult;
    goal: string;
    success: string;
    /** The program that actually ran last (post-rescue) — recipe material */
    steps?: ProgramStep[];
    /** True when a rescue intervened (the original program needed correction) */
    rescued: boolean;
    replanRequest?: Subtask[];
  }> => {
    let currentGoal = subtask.goal;
    let currentSuccess = subtask.success;
    // The program: when present, the harness executes it deterministically —
    // no local planner. Goal-only subtasks fall back to the planner loop.
    let currentSteps: ProgramStep[] | undefined = subtask.steps?.length ? subtask.steps : undefined;
    // Rescue-revised goals are compound instructions — atomic only holds for
    // the orchestrator's original one-action goal
    let currentAtomic = subtask.atomic === true;
    let rescues = 0;
    let retryNote: string[] = [];
    for (;;) {
      const knownData = () => ledger.slice(-8).map(entry => entry.slice(0, 250));
      const run = currentSteps
        ? await runProgramSubtask(
            port,
            tabId,
            taskId,
            `${currentGoal} (success: ${currentSuccess})`,
            currentSteps,
            {
              taskRecordId: record.id,
              success: currentSuccess,
              stepPrefix,
              onExtract: recordExtract,
              knownData,
            },
            signal,
          )
        : await runSubtask(
            port,
            tabId,
            taskId,
            `${currentGoal} (success: ${currentSuccess})`,
            {
              taskRecordId: record.id,
              success: currentSuccess,
              plannedBy: 'orchestrator',
              useLocalValidator: false,
              allowRespondChat: false,
              stepPrefix,
              // rescue 1 → local retry with the corrected goal; rescue 2 →
              // tier-1 cloud; rescue 3 → tier-2 cloud
              endpoint: escalationEndpoint(rescues - 1),
              seedHistory: [
                ...failureMemory.slice(-4),
                ...ledger.slice(-3).map(entry => `DATA already collected earlier in this task: ${entry.slice(0, 300)}`),
                ...retryNote,
              ],
              trackUsage: track,
              atomic: currentAtomic,
              onExtract: recordExtract,
              knownData,
            },
            signal,
          );
      // Rescue any non-ok outcome: 'stuck' (loops) and 'fail' (consecutive
      // failures / step budget) both mean the executor needs help
      if (run.status === 'ok' || run.status === 'streamed' || rescues >= MAX_RESCUES_PER_SUBTASK) {
        return { run, goal: currentGoal, success: currentSuccess, steps: currentSteps, rescued: rescues > 0 };
      }
      rescues++;
      let rescueCall;
      try {
        rescueCall = await rescueSubtask(
          task,
          {
            goal: currentGoal,
            actions: run.actions,
            elements: run.elementsDigest ?? [],
            url: run.url,
            title: run.title,
            priorRescues: rescueLog.slice(-5),
            ledger: ledger.slice(-10),
          },
          signal,
          // GLM-first for diagnosis too: the strong model only reviews once a
          // first correction has already failed
          rescues > 1,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // A failed rescue call is not fatal — report the outcome as-is and
        // let the checkpoint decide what to do with it
        logger.warning('rescue call failed:', error);
        return { run, goal: currentGoal, success: currentSuccess, steps: currentSteps, rescued: rescues > 1 };
      }
      const { result: rescue, usage } = rescueCall;
      const rescueMeta = track(usage);
      logger.info('rescue:', JSON.stringify(rescue).slice(0, 300));
      rescueLog.push(
        `on "${currentGoal.slice(0, 80)}": ${rescue.decision} — ${(rescue.revisedGoal || rescue.reason || '')
          .replace(/\n/g, ' ')
          .slice(0, 200)}`,
      );
      if (rescue.decision === 'retry' && (rescue.revisedGoal || rescue.steps?.length)) {
        // A corrected PROGRAM is the preferred rescue output — deterministic
        // retry. A goal-only revision falls back to the planner ladder.
        currentSteps = rescue.steps?.length ? rescue.steps : undefined;
        const nextEndpoint = currentSteps ? undefined : escalationEndpoint(rescues - 1);
        const escalationNote = currentSteps
          ? ' — retrying with a corrected program'
          : nextEndpoint
            ? ` — escalating executor to ☁ ${nextEndpoint.model}`
            : ' — retrying with the local model';
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Stuck — orchestrator revised the goal${escalationNote}: ${rescue.revisedGoal ?? currentGoal}${rescue.reason ? ` (${rescue.reason})` : ''}`,
          rescueMeta,
        );
        currentGoal = rescue.revisedGoal || currentGoal;
        currentSuccess = rescue.revisedSuccess || currentSuccess;
        currentAtomic = false; // revised goals are compound instructions
        retryNote = [
          `NOTE: a previous attempt at this goal got stuck: ${run.summary.replace(/\n/g, ' ').slice(0, 200)}`,
        ];
        continue;
      }
      if (rescue.decision === 'replan' && rescue.subtasks?.length) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Stuck — orchestrator wants to replan${rescue.reason ? `: ${rescue.reason}` : ''}`,
          rescueMeta,
        );
        return {
          run,
          goal: currentGoal,
          success: currentSuccess,
          steps: currentSteps,
          rescued: true,
          replanRequest: rescue.subtasks,
        };
      }
      // rescue says fail — surface the diagnosis as the outcome summary
      return {
        run: { ...run, status: 'fail', summary: rescue.reason || run.summary },
        goal: currentGoal,
        success: currentSuccess,
        steps: currentSteps,
        rescued: true,
      };
    }
  };

  // Recipe library: saved programs from previous successful runs. Triage sees
  // a one-line digest of each and may match instead of planning (~$0.001
  // parameter fill vs ~$0.01-0.02 cold compile).
  const recipes: RecipeRecord[] = await recipeStore.getAll().catch(error => {
    logger.warning('recipe library read failed:', error);
    return [];
  });

  const initialTriage = await triageTask(task, signal, recipeLibraryDigest(recipes));
  let triage = initialTriage.result;
  let triageMeta = track(initialTriage.usage);
  logger.info('triage:', JSON.stringify(triage).slice(0, 300));

  // Resolve a recipe match; a hallucinated id falls back to plain triage
  let activeRecipe: { recipe: RecipeRecord; params: Record<string, string> } | null = null;
  if (triage.mode === 'recipe') {
    const matched = recipes.find(r => r.id === triage.recipeId);
    if (matched) {
      activeRecipe = { recipe: matched, params: triage.params ?? {} };
    } else {
      logger.warning('triage chose an unknown recipe id, re-triaging without the library:', triage.recipeId);
      const retriage = await triageTask(task, signal);
      triage = retriage.result;
      triageMeta = track(retriage.usage);
    }
  }
  record.mode = triage.mode;

  if (triage.mode === 'chat') {
    // Stream the reply (with full conversation history) instead of dumping
    // the triage JSON's answer as one block
    try {
      const { text, usage } = await streamCloudChatReply(port, taskId, task, signal);
      const meta = usage ? track(usage) : triageMeta;
      finishOk(text || triage.reply || '', meta);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('cloud chat stream failed, falling back to triage reply:', error);
      finishOk(triage.reply || '', triageMeta);
    }
    return;
  }

  // 'execute' runs as a single-subtask plan: it shares the checkpoint loop so
  // replan verdicts work (previously execute treated any non-done verdict as
  // a terminal failure, even when the checkpoint knew exactly how to fix it)
  let plan: Subtask[];
  if (activeRecipe) {
    plan = instantiateRecipe(activeRecipe.recipe, activeRecipe.params).slice(0, MAX_SUBTASKS);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `Recipe: ${activeRecipe.recipe.name} @ ${activeRecipe.recipe.site} — running the saved program (${plan.length} subtask${plan.length === 1 ? '' : 's'}):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
      triageMeta,
    );
    recipeStore.recordUse(activeRecipe.recipe.id).catch(error => logger.warning('recipe use record failed:', error));
  } else if (triage.mode === 'execute') {
    // Triage supplies the single-step program when it can; goal-only fallback
    plan = triage.subtasks?.length ? triage.subtasks.slice(0, 1) : [{ goal: task, success: 'the task is complete' }];
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      'Triage: single concrete goal — executing directly with the local model.',
      triageMeta,
    );
  } else {
    plan = (triage.subtasks ?? []).slice(0, MAX_SUBTASKS);
    // Degenerate triage (e.g. recipe mode surviving the fallback) still runs
    if (plan.length === 0) plan = [{ goal: task, success: 'the task is complete' }];
  }
  let index = 0;

  // Recipe material: the final (post-rescue) program of every subtask that
  // succeeded, in execution order — what saveRecipeCandidate parameterizes
  const executedPlan: Subtask[] = [];
  const maybeSaveRecipe = async () => {
    // Cold plan-mode runs only: recipe runs record use/repairs instead, and
    // single-action execute tasks are not worth saving. Fires on done AND on
    // useful salvage — a partial run's succeeded programs are still verified
    // site lore (the parameterizer names the recipe for what it actually does)
    if (record.mode !== 'plan' || executedPlan.length === 0) return;
    // Nothing deterministic to replay — a recipe of goal-only improvisation
    // would re-run the unreliable path, not the verified one
    if (!executedPlan.some(s => s.steps?.length)) return;
    const saved = await saveRecipeCandidate(task, record.id, executedPlan, signal, track);
    if (saved) {
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Saved recipe: ${saved} — matching tasks will now reuse this verified program.`,
      );
    }
  };

  const applyReplan = (subtasks: Subtask[], meta: string, label: string): boolean => {
    if (record.replans >= MAX_REPLANS) return false;
    record.replans++;
    plan = subtasks.slice(0, MAX_SUBTASKS);
    index = 0;
    // The plan no longer maps 1:1 onto the recipe's subtasks — stop
    // attributing outcomes (and repairs) to it
    activeRecipe = null;
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `${label} (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
      meta,
    );
    return true;
  };

  if (triage.mode === 'plan') {
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `Plan (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
      triageMeta,
    );
  }

  // Run subtasks until the plan is exhausted; 'finished' means a terminal
  // event was already posted, 'exhausted' means the plan ran out undecided
  const executePlan = async (): Promise<'finished' | 'exhausted'> => {
    while (index < plan.length && outcomes.length < MAX_SUBTASKS + MAX_REPLANS * 2) {
      const subtask = plan[index];
      if (plan.length > 1) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Subtask ${index + 1}/${plan.length}: ${subtask.goal}`,
        );
      }

      const { run, goal, success, steps, rescued, replanRequest } = await runWithRescue(
        subtask,
        plan.length > 1 ? `[${index + 1}/${plan.length}] ` : '',
      );
      outcomes.push(toOutcome(goal, run, settings.cloudExecutorEnabled));
      rememberFailure(goal, run);
      if (run.status === 'ok') executedPlan.push({ goal, success, steps });

      // Recipe self-healing: a rescue corrected this recipe-sourced subtask's
      // program and the correction succeeded — write the fix back (with this
      // run's param values swapped back to placeholders)
      const recipeRun = activeRecipe;
      if (recipeRun && run.status === 'ok' && rescued && steps?.length && index < recipeRun.recipe.subtasks.length) {
        const repaired = parameterizeSubtask(goal, success, steps, recipeRun.params);
        const subtaskNumber = index + 1;
        recipeStore
          .repairSubtask(recipeRun.recipe.id, index, repaired)
          .then(() =>
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `Recipe self-healed: subtask ${subtaskNumber} of "${recipeRun.recipe.name}" now uses the corrected program.`,
            ),
          )
          .catch(error => logger.warning('recipe repair failed:', error));
      }

      // Surface the outcome — silent false "done" claims made runs unreadable
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Subtask outcome: ${run.status === 'ok' ? 'ok' : run.status} — ${run.summary.replace(/\n/g, ' ').slice(0, 160)}`,
      );

      if (replanRequest) {
        if (!applyReplan(replanRequest, '', 'Replanned')) {
          await finishWithSalvage('Replan budget exhausted while stuck.', '');
          return 'finished';
        }
        continue;
      }

      let checkpointCall;
      try {
        checkpointCall = await checkpoint(task, plan, leanOutcomes(outcomes), signal, ledger);
      } catch (error) {
        if (signal.aborted) throw error;
        // The checkpoint is orchestration, not execution — its failure must
        // salvage what was collected, never discard it
        logger.warning('checkpoint failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        await finishWithSalvage(`Orchestrator checkpoint failed: ${message.slice(0, 200)}`, '');
        return 'finished';
      }
      const { result: verdict, usage } = checkpointCall;
      const checkpointMeta = track(usage);
      logger.info('checkpoint:', JSON.stringify(verdict).slice(0, 300));

      if (verdict.decision === 'done') {
        await maybeSaveRecipe();
        finishOk(verdict.answer || 'Task complete.', checkpointMeta);
        return 'finished';
      }
      if (verdict.decision === 'fail') {
        await finishWithSalvage(verdict.reason || 'The orchestrator gave up.', checkpointMeta);
        return 'finished';
      }
      if (verdict.decision === 'replan') {
        if (!verdict.subtasks?.length || !applyReplan(verdict.subtasks, checkpointMeta, 'Replanned')) {
          await finishWithSalvage(`Replan budget exhausted. ${verdict.reason ?? ''}`.trim(), checkpointMeta);
          return 'finished';
        }
        continue;
      }
      index++;
    }
    return 'exhausted';
  };

  for (;;) {
    if ((await executePlan()) === 'finished') return;

    // Plan ran out without an explicit done — ask for a final verdict. The
    // verdict may REPLAN (e.g. the plan never included the final deliverable,
    // like typing collected data into the doc it opened) — honor it instead
    // of discarding the orchestrator's own instructions.
    let finalCall;
    try {
      finalCall = await checkpoint(task, plan, leanOutcomes(outcomes), signal, ledger);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('final checkpoint failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      await finishWithSalvage(`Orchestrator checkpoint failed: ${message.slice(0, 200)}`, '');
      return;
    }
    const { result: final, usage: finalUsage } = finalCall;
    const finalMeta = track(finalUsage);
    if (final.decision === 'done') {
      await maybeSaveRecipe();
      finishOk(final.answer || 'Task complete.', finalMeta);
      return;
    }
    if (
      final.decision === 'replan' &&
      final.subtasks?.length &&
      applyReplan(final.subtasks, finalMeta, 'Replanned (completing the deliverable)')
    ) {
      continue;
    }
    await finishWithSalvage(final.reason || 'Plan completed without a confirmed result.', finalMeta);
    return;
  }
}

function toOutcome(goal: string, run: SubtaskRunResult, includePageText: boolean): SubtaskOutcome {
  return {
    goal,
    status: run.status === 'ok' ? 'ok' : 'fail',
    summary: run.summary,
    actions: run.actions,
    url: run.url,
    title: run.title,
    evidence: run.elementsDigest,
    // Page text crosses the cloud boundary only when the user opened it
    // (same gate as the cloud executor fallback)
    pageTextExcerpt: includePageText ? run.pageTextExcerpt : undefined,
  };
}

/** Evidence is only useful for judging the CURRENT page — strip it from all
 * but the latest outcome so checkpoint payloads stay lean. */
function leanOutcomes(outcomes: SubtaskOutcome[]): SubtaskOutcome[] {
  return outcomes.map((o, i) =>
    i === outcomes.length - 1 ? o : { ...o, evidence: undefined, pageTextExcerpt: undefined },
  );
}

/**
 * Task entry point. Hybrid (orchestrated) when a cloud orchestrator is
 * configured; otherwise the original local-only loop. Always writes a
 * TaskRecord (the end-to-end training label).
 */
export async function runAgentTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);
  const settings = await chatSettingsStore.getSettings();
  const record: TaskRecord = {
    id: crypto.randomUUID(),
    sessionId: taskId,
    task,
    mode: 'local',
    outcome: 'fail',
    answer: '',
    replans: 0,
    totalCostUsd: 0,
    cloudCalls: 0,
    localModel: settings.model,
    grounderModel: settings.grounderModel,
    startedAt: Date.now(),
    endedAt: 0,
  };
  try {
    if (await isOrchestratorConfigured()) {
      await runOrchestratedTask(port, tabId, taskId, task, record, signal);
    } else {
      await runLocalTask(port, tabId, taskId, task, record, signal);
    }
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    if (signal.aborted) {
      record.outcome = 'cancel';
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      record.outcome = 'fail';
      record.answer = message;
      logger.error('agent task failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  } finally {
    // Drop the CDP session (and its "started debugging" infobar) at task end
    await detachCdp(tabId).catch(() => {});
    record.endedAt = Date.now();
    trajectoryStore.appendTask(record).catch(error => logger.warning('task record failed:', error));
  }
}
