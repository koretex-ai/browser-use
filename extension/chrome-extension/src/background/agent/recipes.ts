import type { RecipeRecord, RecipeSubtask } from '@extension/storage';
import { recipeStore } from '@extension/storage';
import { createLogger } from '../log';
import { parameterizeRecipe } from './orchestrator';
import type { Subtask, ProgramStep, CallUsage } from './orchestrator';

const logger = createLogger('recipes');

/**
 * Recipes: saved, parameterized subtask programs (see packages/storage
 * recipes/types.ts). This module is the glue between the orchestrator and the
 * store — building the triage digest, filling params in, pulling them back
 * out for self-healing write-backs, and saving candidates after a cold run.
 */

// The triage prompt gets at most this many recipes (most recently used first)
const MAX_RECIPES_IN_TRIAGE = 12;
// Param values shorter than this are too ambiguous to reverse-substitute
// (a 2-char value like "10" would clobber unrelated text in a repaired step)
const MIN_REVERSE_PARAM_LENGTH = 4;

/** One line per recipe: enough for triage to match, nothing more. */
export function recipeLibraryDigest(recipes: RecipeRecord[]): string[] {
  return [...recipes]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECIPES_IN_TRIAGE)
    .map(r => {
      const params = r.params.length ? `; params: ${r.params.map(p => `${p.name} (${p.description})`).join(', ')}` : '';
      return `[${r.id}] ${r.name} @ ${r.site} — ${r.intent}${params}`;
    });
}

function substitute(text: string, params: Record<string, string>): string {
  return text.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, name: string) => params[name] ?? match);
}

const STEP_STRING_FIELDS = ['url', 'target', 'text', 'combo', 'query', 'question'] as const;

/** Fill a recipe's {param} placeholders with this task's values. */
export function instantiateRecipe(recipe: RecipeRecord, params: Record<string, string>): Subtask[] {
  return recipe.subtasks.map(subtask => ({
    goal: substitute(subtask.goal, params),
    success: substitute(subtask.success, params),
    steps: subtask.steps?.map(step => {
      const filled: ProgramStep = { ...step };
      for (const field of STEP_STRING_FIELDS) {
        const value = filled[field];
        if (typeof value === 'string') filled[field] = substitute(value, params);
      }
      return filled;
    }),
  }));
}

function reverseSubstitute(text: string, params: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(params)) {
    if (value.length < MIN_REVERSE_PARAM_LENGTH) continue;
    out = out.split(value).join(`{${name}}`);
  }
  return out;
}

/**
 * Reverse substitution for self-healing: a rescue's corrected program carries
 * this run's literal param values — swap them back to {param} placeholders so
 * the repaired subtask can be written into the recipe. Deterministic, no
 * model call.
 */
export function parameterizeSubtask(
  goal: string,
  success: string,
  steps: ProgramStep[],
  params: Record<string, string>,
): RecipeSubtask {
  return {
    goal: reverseSubstitute(goal, params),
    success: reverseSubstitute(success, params),
    steps: steps.map(step => {
      const blanked: ProgramStep = { ...step };
      for (const field of STEP_STRING_FIELDS) {
        const value = blanked[field];
        if (typeof value === 'string') blanked[field] = reverseSubstitute(value, params);
      }
      return blanked;
    }),
  };
}

/**
 * Auto-save hook after a verified cold-run success: ask the orchestrator to
 * parameterize the executed plan; store it when it says the pattern is worth
 * keeping. Returns a display handle like "post-to-linkedin(message)", or null
 * when nothing was saved. Never throws — recipe saving must not fail a task
 * that already succeeded.
 */
export async function saveRecipeCandidate(
  task: string,
  sourceTaskId: string,
  executedPlan: Subtask[],
  signal: AbortSignal,
  track: (usage: CallUsage) => string,
): Promise<string | null> {
  try {
    const { result, usage } = await parameterizeRecipe(task, executedPlan, signal);
    track(usage);
    if (!result.save || !result.name || !result.site || !result.subtasks?.length) return null;
    const record: RecipeRecord = {
      id: crypto.randomUUID(),
      name: result.name,
      site: result.site,
      intent: result.intent ?? task.slice(0, 200),
      params: (result.params ?? []).filter(p => p?.name),
      subtasks: result.subtasks,
      sourceTaskId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };
    await recipeStore.upsert(record);
    return `${record.name}(${record.params.map(p => p.name).join(', ')})`;
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warning('recipe save failed:', error);
    return null;
  }
}
