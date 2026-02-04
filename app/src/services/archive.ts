import AsyncStorage from '@react-native-async-storage/async-storage';
import { ArchivedConversation } from '../types';

const ARCHIVE_KEY = 'conversation_archive';
const MAX_ARCHIVES = 100; // Keep last 100 compacted conversations

class ArchiveService {
  private archives: ArchivedConversation[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await AsyncStorage.getItem(ARCHIVE_KEY);
      if (data) {
        this.archives = JSON.parse(data);
      }
      this.loaded = true;
    } catch (err) {
      console.error('Failed to load archives:', err);
      this.archives = [];
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    try {
      await AsyncStorage.setItem(ARCHIVE_KEY, JSON.stringify(this.archives));
    } catch (err) {
      console.error('Failed to save archives:', err);
    }
  }

  async addArchive(archive: Omit<ArchivedConversation, 'id'>): Promise<ArchivedConversation> {
    await this.load();

    const newArchive: ArchivedConversation = {
      ...archive,
      id: `archive-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    // Add to front (most recent first)
    this.archives.unshift(newArchive);

    // Trim to max size
    if (this.archives.length > MAX_ARCHIVES) {
      this.archives = this.archives.slice(0, MAX_ARCHIVES);
    }

    await this.save();
    return newArchive;
  }

  async getArchives(): Promise<ArchivedConversation[]> {
    await this.load();
    return [...this.archives];
  }

  async getArchivesByServer(serverId: string): Promise<ArchivedConversation[]> {
    await this.load();
    return this.archives.filter((a) => a.serverId === serverId);
  }

  async deleteArchive(id: string): Promise<void> {
    await this.load();
    this.archives = this.archives.filter((a) => a.id !== id);
    await this.save();
  }

  async clearAll(): Promise<void> {
    this.archives = [];
    await this.save();
  }
}

export const archiveService = new ArchiveService();
