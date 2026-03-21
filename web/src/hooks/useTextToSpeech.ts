import { useState, useEffect, useCallback, useRef } from 'react';

const VOICE_STORAGE_KEY = 'voice-mode-voice';
const RATE_STORAGE_KEY = 'voice-mode-rate';
const MAX_CHUNK_LENGTH = 200;

interface UseTextToSpeechReturn {
  speaking: boolean;
  paused: boolean;
  voices: SpeechSynthesisVoice[];
  selectedVoice: SpeechSynthesisVoice | null;
  rate: number;
  supported: boolean;
  speak: (text: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setVoice: (voice: SpeechSynthesisVoice) => void;
  setRate: (rate: number) => void;
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_LENGTH) {
      chunks.push(remaining.trim());
      break;
    }

    // Look for sentence boundaries within the limit
    const window = remaining.slice(0, MAX_CHUNK_LENGTH);
    let splitIndex = -1;

    // Try sentence-ending punctuation followed by space
    for (const sep of ['. ', '! ', '? ']) {
      const idx = window.lastIndexOf(sep);
      if (idx > splitIndex) {
        splitIndex = idx + sep.length;
      }
    }

    // Try newline
    if (splitIndex === -1) {
      const newlineIdx = window.lastIndexOf('\n');
      if (newlineIdx > 0) {
        splitIndex = newlineIdx + 1;
      }
    }

    // Fall back to space
    if (splitIndex === -1) {
      const spaceIdx = window.lastIndexOf(' ');
      if (spaceIdx > 0) {
        splitIndex = spaceIdx + 1;
      }
    }

    // Last resort: hard cut
    if (splitIndex === -1) {
      splitIndex = MAX_CHUNK_LENGTH;
    }

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex);
  }

  return chunks.filter(c => c.length > 0);
}

export function useTextToSpeech(): UseTextToSpeechReturn {
  const [supported] = useState(() => 'speechSynthesis' in window);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [rate, setRateState] = useState(() => {
    const stored = localStorage.getItem(RATE_STORAGE_KEY);
    return stored ? parseFloat(stored) : 1.0;
  });

  const activeChunksRef = useRef(0);

  // Load voices and restore persisted voice
  useEffect(() => {
    if (!supported) return;

    const loadVoices = () => {
      const available = speechSynthesis.getVoices();
      setVoices(available);

      const storedName = localStorage.getItem(VOICE_STORAGE_KEY);
      if (storedName && available.length > 0) {
        const match = available.find(v => v.name === storedName);
        if (match) {
          setSelectedVoice(match);
        }
      }
    };

    loadVoices();
    speechSynthesis.addEventListener('voiceschanged', loadVoices);

    return () => {
      speechSynthesis.removeEventListener('voiceschanged', loadVoices);
      speechSynthesis.cancel();
    };
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!supported) return;

    speechSynthesis.cancel();
    activeChunksRef.current = 0;
    setSpeaking(false);
    setPaused(false);

    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) return;

    console.log(`[TTS] speak() called: ${text.length} chars, ${chunks.length} chunks`);

    activeChunksRef.current = chunks.length;

    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = rate;

      utterance.onstart = () => {
        console.log(`[TTS] chunk ${index + 1}/${chunks.length} started (${chunk.length} chars)`);
        if (index === 0) {
          setSpeaking(true);
        }
      };

      utterance.onend = () => {
        console.log(`[TTS] chunk ${index + 1}/${chunks.length} finished`);
        activeChunksRef.current--;
        if (activeChunksRef.current <= 0) {
          console.log('[TTS] all chunks finished');
          setSpeaking(false);
          setPaused(false);
        }
      };

      utterance.onerror = (event) => {
        console.log(`[TTS] error on chunk ${index + 1}/${chunks.length}: ${event.error}`);
        activeChunksRef.current--;
        if (activeChunksRef.current <= 0) {
          setSpeaking(false);
          setPaused(false);
        }
      };

      speechSynthesis.speak(utterance);
    });
  }, [supported, selectedVoice, rate]);

  const pause = useCallback(() => {
    if (!supported) return;
    console.log('[TTS] pause()');
    speechSynthesis.pause();
    setPaused(true);
  }, [supported]);

  const resume = useCallback(() => {
    if (!supported) return;
    console.log('[TTS] resume()');
    speechSynthesis.resume();
    setPaused(false);
  }, [supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    console.log('[TTS] stop()');
    speechSynthesis.cancel();
    activeChunksRef.current = 0;
    setSpeaking(false);
    setPaused(false);
  }, [supported]);

  const setVoice = useCallback((voice: SpeechSynthesisVoice) => {
    setSelectedVoice(voice);
    localStorage.setItem(VOICE_STORAGE_KEY, voice.name);
  }, []);

  const setRate = useCallback((newRate: number) => {
    const clamped = Math.min(2.0, Math.max(0.5, newRate));
    setRateState(clamped);
    localStorage.setItem(RATE_STORAGE_KEY, String(clamped));
  }, []);

  return {
    speaking,
    paused,
    voices,
    selectedVoice,
    rate,
    supported,
    speak,
    pause,
    resume,
    stop,
    setVoice,
    setRate,
  };
}
