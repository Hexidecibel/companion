import { describe, it, expect } from 'vitest';
import { pickVoice, rankVoices, voicesForPicker } from '../voices';
import type { TtsVoice } from '../types';

const v = (name: string, lang = 'en-US', local = true, isDefault = false): TtsVoice => ({ id: name, name, lang, local, isDefault });

describe('voice ranking', () => {
  const voices = [
    v('espeak-ng English', 'en', true, true),
    v('Fred'),
    v('Microsoft David - English (United States)'),
    v('Google US English', 'en-US', false),
    v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false),
    v('Samantha'),
    v('Google Deutsch', 'de-DE', false),
  ];

  it('prefers natural/neural English over robotic defaults', () => {
    const ranked = rankVoices(voices).map((x) => x.name);
    expect(ranked[0]).toMatch(/Aria Online \(Natural\)/);
    expect(ranked.indexOf('espeak-ng English')).toBeGreaterThan(ranked.indexOf('Samantha'));
    expect(ranked.indexOf('Fred')).toBeGreaterThan(ranked.indexOf('Microsoft David - English (United States)'));
    expect(ranked[ranked.length - 1]).toBe('Google Deutsch');
  });

  it('honours a saved voice and falls back when it disappears', () => {
    expect(pickVoice(voices, 'Samantha')?.name).toBe('Samantha');
    expect(pickVoice(voices, 'gone')?.name).toMatch(/Aria/);
    expect(pickVoice([], null)).toBeNull();
  });

  it('splits picker lists into English and other, hiding novelty from recommended', () => {
    const { recommended, other } = voicesForPicker(voices);
    expect(recommended.map((x) => x.name)).not.toContain('Fred');
    expect(other.map((x) => x.name)).toEqual(expect.arrayContaining(['Fred', 'Google Deutsch']));
  });
});
