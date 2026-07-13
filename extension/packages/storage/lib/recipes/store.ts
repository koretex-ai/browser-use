import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { RecipeRecord, RecipeStorage } from './types';

const recipesStorage = createStorage<RecipeRecord[]>('recipes', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

export const recipeStore: RecipeStorage = {
  getAll: async () => recipesStorage.get(),

  upsert: async record => {
    await recipesStorage.set(prev => {
      const existing = prev.find(r => r.name === record.name && r.site === record.site);
      if (!existing) return [...prev, record];
      // A re-save of the same pattern refreshes the program but keeps the
      // recipe's identity and usage history
      return prev.map(r =>
        r === existing ? { ...record, id: existing.id, createdAt: existing.createdAt, useCount: existing.useCount } : r,
      );
    });
  },

  recordUse: async id => {
    await recipesStorage.set(prev =>
      prev.map(r => (r.id === id ? { ...r, useCount: r.useCount + 1, lastUsedAt: Date.now() } : r)),
    );
  },

  repairSubtask: async (id, index, subtask) => {
    await recipesStorage.set(prev =>
      prev.map(r =>
        r.id === id && index >= 0 && index < r.subtasks.length
          ? { ...r, subtasks: r.subtasks.map((s, i) => (i === index ? subtask : s)), lastRepairedAt: Date.now() }
          : r,
      ),
    );
  },

  remove: async id => {
    await recipesStorage.set(prev => prev.filter(r => r.id !== id));
  },

  clearAll: async () => {
    await recipesStorage.set([]);
  },
};
