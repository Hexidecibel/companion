import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTextToSpeech } from './useTextToSpeech';
import { useSpeechRecognition } from './useSpeechRecognition';
import { prepareForSpeech, summarizeToolCalls } from '../utils/ttsPrep';
import type { ConversationHighlight } from '../types';

const AUTO_READ_KEY = 'voice-mode-auto-read';
const HANDS_FREE_KEY = 'voice-mode-hands-free';
const SILENCE_TIMEOUT_MS = 2000;

export function useVoiceMode(
  highlights: ConversationHighlight[],
  sendInput: (text: string) => Promise<boolean>,
  status: { isWaitingForInput: boolean; isRunning: boolean } | null,
) {
  const tts = useTextToSpeech();
  const stt = useSpeechRecognition();

  const [autoRead, setAutoRead] = useState(() => {
    const stored = localStorage.getItem(AUTO_READ_KEY);
    return stored !== null ? stored === 'true' : true;
  });

  const [handsFree, setHandsFree] = useState(() => {
    const stored = localStorage.getItem(HANDS_FREE_KEY);
    return stored !== null ? stored === 'true' : false;
  });

  const lastReadMessageId = useRef<string | null>(null);
  const silenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which assistant message index is currently being read (-1 = none)
  const [currentReadIndex, setCurrentReadIndex] = useState<number>(-1);

  // Compute assistant messages list
  const assistantMessages = useMemo(
    () => highlights.filter(h => h.type === 'assistant' && !h.isPending),
    [highlights],
  );

  const assistantMessageCount = assistantMessages.length;

  // Helper to get speech text from a highlight
  const getSpeechText = useCallback((highlight: ConversationHighlight): string => {
    let speechText = prepareForSpeech(highlight.content);
    if (highlight.toolCalls) {
      const toolSummary = summarizeToolCalls(highlight.toolCalls);
      if (toolSummary) {
        speechText = speechText ? speechText + ' ' + toolSummary : toolSummary;
      }
    }
    return speechText;
  }, []);

  // Auto-read: speak new assistant messages
  useEffect(() => {
    if (!autoRead || highlights.length === 0) return;

    const last = highlights[highlights.length - 1];
    if (
      last.type === 'assistant' &&
      !last.isPending &&
      last.id !== lastReadMessageId.current
    ) {
      const speechText = getSpeechText(last);
      tts.speak(speechText);
      lastReadMessageId.current = last.id;
      // Set current read index to the last assistant message
      setCurrentReadIndex(assistantMessages.length - 1);
    }
  }, [highlights, autoRead, tts.speak, getSpeechText, assistantMessages.length]);

  const toggleAutoRead = useCallback(() => {
    setAutoRead(prev => {
      const next = !prev;
      localStorage.setItem(AUTO_READ_KEY, String(next));
      return next;
    });
  }, []);

  const toggleHandsFree = useCallback(() => {
    setHandsFree(prev => {
      const next = !prev;
      localStorage.setItem(HANDS_FREE_KEY, String(next));
      console.log('[Voice] Hands-free mode:', next ? 'enabled' : 'disabled');
      return next;
    });
  }, []);

  const readMessage = useCallback(
    (highlight: ConversationHighlight) => {
      const speechText = getSpeechText(highlight);
      tts.speak(speechText);
      // Find the index of this message in assistantMessages
      const idx = assistantMessages.findIndex(h => h.id === highlight.id);
      if (idx >= 0) {
        setCurrentReadIndex(idx);
      }
    },
    [tts.speak, getSpeechText, assistantMessages],
  );

  const readCurrentMessage = useCallback(() => {
    for (let i = highlights.length - 1; i >= 0; i--) {
      if (highlights[i].type === 'assistant') {
        readMessage(highlights[i]);
        return;
      }
    }
  }, [highlights, readMessage]);

  const skipMessage = useCallback(
    (direction: 'prev' | 'next' = 'prev') => {
      console.log('[Voice] Skip requested, direction:', direction, 'currentIndex:', currentReadIndex);
      tts.stop();

      if (assistantMessages.length === 0) {
        console.log('[Voice] No assistant messages to skip to');
        return;
      }

      let targetIndex: number;
      if (direction === 'prev') {
        targetIndex = currentReadIndex > 0 ? currentReadIndex - 1 : -1;
      } else {
        targetIndex = currentReadIndex < assistantMessages.length - 1 ? currentReadIndex + 1 : -1;
      }

      if (targetIndex < 0 || targetIndex >= assistantMessages.length) {
        console.log('[Voice] No more messages in direction:', direction);
        setCurrentReadIndex(-1);
        return;
      }

      const target = assistantMessages[targetIndex];
      const speechText = getSpeechText(target);
      console.log('[Voice] Skipping to message', targetIndex + 1, 'of', assistantMessages.length);

      // Small delay to let stop() complete before starting new speech
      setTimeout(() => {
        tts.speak(speechText);
      }, 50);
      setCurrentReadIndex(targetIndex);
    },
    [currentReadIndex, assistantMessages, tts, getSpeechText],
  );

  const sendVoiceInput = useCallback(async () => {
    const text = stt.transcript;
    if (!text) return false;
    const result = await sendInput(text);
    stt.clearTranscript();
    return result;
  }, [stt.transcript, stt.clearTranscript, sendInput]);

  // Hands-free: auto-stop mic when TTS starts speaking (avoid feedback)
  useEffect(() => {
    if (!handsFree) return;
    if (tts.speaking && stt.listening) {
      console.log('[Voice] Hands-free: stopping mic (TTS started speaking)');
      stt.stopListening();
    }
  }, [handsFree, tts.speaking, stt.listening, stt.stopListening]);

  // Hands-free: auto-listen when waiting for input
  useEffect(() => {
    if (!handsFree) return;

    if (status?.isWaitingForInput && !tts.speaking && !stt.listening) {
      console.log('[Voice] Hands-free: auto-listen start (waiting for input)');
      stt.startListening();
    } else if (!status?.isWaitingForInput && stt.listening) {
      console.log('[Voice] Hands-free: auto-listen stop (no longer waiting)');
      stt.stopListening();
    }
  }, [handsFree, status?.isWaitingForInput, tts.speaking, stt.listening, stt.startListening, stt.stopListening]);

  // Hands-free: auto-send after silence (2s of no interim transcript while transcript has content)
  useEffect(() => {
    if (!handsFree || !stt.listening) {
      // Clear any pending timeout if hands-free disabled or not listening
      if (silenceTimeoutRef.current) {
        console.log('[Voice] Hands-free: silence timeout cleared (not active)');
        clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }
      return;
    }

    if (stt.transcript && !stt.interimTranscript) {
      // Transcript has content but no interim — user may have stopped speaking
      if (!silenceTimeoutRef.current) {
        console.log('[Voice] Hands-free: silence timeout set (' + SILENCE_TIMEOUT_MS + 'ms)');
        silenceTimeoutRef.current = setTimeout(() => {
          console.log('[Voice] Hands-free: auto-send triggered (silence detected)');
          silenceTimeoutRef.current = null;
          sendVoiceInput();
        }, SILENCE_TIMEOUT_MS);
      }
    } else {
      // Interim transcript has new content or transcript is empty — clear timeout
      if (silenceTimeoutRef.current) {
        console.log('[Voice] Hands-free: silence timeout cleared (new speech detected)');
        clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }
    }
  }, [handsFree, stt.listening, stt.transcript, stt.interimTranscript, sendVoiceInput]);

  // Cleanup silence timeout on unmount
  useEffect(() => {
    return () => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
    };
  }, []);

  return {
    // TTS
    speaking: tts.speaking,
    paused: tts.paused,
    rate: tts.rate,
    ttsSupported: tts.supported,
    voices: tts.voices,
    selectedVoice: tts.selectedVoice,
    speak: tts.speak,
    pause: tts.pause,
    resume: tts.resume,
    stop: tts.stop,
    setVoice: tts.setVoice,
    setRate: tts.setRate,

    // STT
    listening: stt.listening,
    transcript: stt.transcript,
    interimTranscript: stt.interimTranscript,
    sttSupported: stt.supported,
    error: stt.error,
    requiresNetwork: stt.requiresNetwork,
    startListening: stt.startListening,
    stopListening: stt.stopListening,
    clearTranscript: stt.clearTranscript,

    // Voice mode
    autoRead,
    toggleAutoRead,
    handsFree,
    toggleHandsFree,
    readCurrentMessage,
    readMessage,
    sendVoiceInput,
    skipMessage,
    currentReadIndex,
    assistantMessageCount,
    assistantMessages,
  };
}
