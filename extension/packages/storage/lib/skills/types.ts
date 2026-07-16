/**
 * User-defined SKILLS (site playbooks): the same shape the agent's built-in
 * playbooks use, kept serializable for chrome.storage and for sharing as
 * plain JSON files. A custom skill whose name matches a built-in playbook
 * REPLACES it — users can correct our lore, not just extend it.
 */

/**
 * Provenance of a skill taught by demonstration: the semantic event log
 * (actions described in the navigator's vocabulary — not video, not a DOM
 * stream), the user's notes, and the distiller's interview Q&A. Kept so
 * future engine upgrades (step fast-paths, flows) can re-distill without
 * re-teaching. Screenshots are never persisted.
 */
export interface SkillSource {
  recordedAt: number;
  /** Rendered event lines, e.g. 'click "the Post button inside the composer" (x.com/home)' */
  events: string[];
  /** Notes the user typed while recording */
  notes: string[];
  /** Distiller interview answers */
  qa: { question: string; answer: string }[];
}

export interface CustomSkillRecord {
  /** Unique name (also the override key against built-ins), e.g. "notion" */
  name: string;
  /** Host/path substrings that trigger the skill when the tab matches, e.g. "notion.so" */
  hosts: string[];
  /**
   * Optional regex source (case-insensitive) matched against the task
   * objective — lets the skill fire before the site is even open.
   */
  intent?: string;
  /** The playbook text pinned into the navigator's prompt when triggered */
  guidance: string;
  /** Present when the skill was taught by demonstration */
  source?: SkillSource;
  createdAt: number;
  updatedAt: number;
}

export interface SkillStorage {
  getAll: () => Promise<CustomSkillRecord[]>;
  /** Insert or update by name */
  upsert: (record: Omit<CustomSkillRecord, 'createdAt' | 'updatedAt'>) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** Replace the whole set (used by import) */
  replaceAll: (records: CustomSkillRecord[]) => Promise<void>;
}
