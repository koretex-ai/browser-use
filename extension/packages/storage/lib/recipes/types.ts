/**
 * Recipes: saved, parameterized subtask programs.
 *
 * A recipe is the executed (post-rescue, checkpoint-verified) program of a
 * successful task with the task-specific literals replaced by {param}
 * placeholders. Recipes are DATA, not code — site-specific knowledge (URLs,
 * element labels, quirks) belongs here, never in the harness. Repeat tasks
 * match a recipe at triage and skip plan compilation entirely.
 */

/** Structurally identical to the background's ProgramStep (kept serializable). */
export interface RecipeStep {
  do: string;
  url?: string;
  target?: string;
  text?: string;
  combo?: string;
  query?: string;
  question?: string;
  until?: number;
  maxScrolls?: number;
  direction?: 'up' | 'down';
  times?: number;
  ms?: number;
}

export interface RecipeSubtask {
  goal: string;
  success: string;
  steps?: RecipeStep[];
}

export interface RecipeParam {
  /** Placeholder name as it appears in the program, e.g. "message" for {message} */
  name: string;
  /** What to fill it with, e.g. "the text to post" */
  description: string;
}

export interface RecipeRecord {
  id: string;
  /** Kebab-case handle, e.g. "post-to-linkedin" */
  name: string;
  /** Primary site the recipe operates on, e.g. "linkedin.com" */
  site: string;
  /** One-line description of what the recipe accomplishes (triage matching key) */
  intent: string;
  params: RecipeParam[];
  subtasks: RecipeSubtask[];
  /** TaskRecord id of the run this recipe was saved from */
  sourceTaskId: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  /** Set when a rescue's corrected program was written back (self-healing) */
  lastRepairedAt?: number;
}

export interface RecipeStorage {
  getAll: () => Promise<RecipeRecord[]>;
  /** Insert, or replace an existing recipe with the same name+site (keeps its id and usage stats) */
  upsert: (record: RecipeRecord) => Promise<void>;
  recordUse: (id: string) => Promise<void>;
  /** Self-healing write-back: replace one subtask's program after a verified repair */
  repairSubtask: (id: string, index: number, subtask: RecipeSubtask) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
}
