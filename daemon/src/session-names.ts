import * as fs from 'fs';
import * as path from 'path';

/**
 * Simple JSON file store for user-assigned session friendly names.
 * Persisted at ~/.companion/session-names.json
 */
export class SessionNameStore {
  private filePath: string;
  private names: Record<string, string> = {};

  constructor(configDir: string) {
    this.filePath = path.join(configDir, 'session-names.json');
    this.load();
  }

  private load(): void {
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      this.names = JSON.parse(data);
    } catch {
      this.names = {};
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.names, null, 2));
  }

  get(sessionId: string): string | undefined {
    return this.names[sessionId];
  }

  set(sessionId: string, name: string): void {
    this.names[sessionId] = name;
    this.save();
  }

  delete(sessionId: string): void {
    delete this.names[sessionId];
    this.save();
  }

  getAll(): Record<string, string> {
    return { ...this.names };
  }
}
