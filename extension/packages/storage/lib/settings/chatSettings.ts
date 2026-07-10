import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Settings for the local chat model served by Ollama
export interface ChatSettingsConfig {
  baseUrl: string;
  model: string;
}

export type ChatSettingsStorage = BaseStorage<ChatSettingsConfig> & {
  updateSettings: (settings: Partial<ChatSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<ChatSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettingsConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
};

const storage = createStorage<ChatSettingsConfig>('chat-settings', DEFAULT_CHAT_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const chatSettingsStore: ChatSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<ChatSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_CHAT_SETTINGS;
    await storage.set({
      ...currentSettings,
      ...settings,
    });
  },
  async getSettings() {
    const settings = await storage.get();
    return {
      ...DEFAULT_CHAT_SETTINGS,
      ...settings,
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_CHAT_SETTINGS);
  },
};
