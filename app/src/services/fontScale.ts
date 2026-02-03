import { getSettings, saveSettings } from './storage';

type Listener = (scale: number) => void;

class FontScaleService {
  private scale = 1.0;
  private listeners: Set<Listener> = new Set();

  getScale(): number {
    return this.scale;
  }

  async load(): Promise<void> {
    const settings = await getSettings();
    this.scale = settings.fontScale ?? 1.0;
  }

  async setScale(scale: number): Promise<void> {
    this.scale = scale;
    this.notify();
    const settings = await getSettings();
    await saveSettings({ ...settings, fontScale: scale });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.scale);
    }
  }
}

export const fontScaleService = new FontScaleService();
