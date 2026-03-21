import { useState, useEffect, useRef, useCallback } from 'react';

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface UseSpeechRecognitionReturn {
  listening: boolean;
  transcript: string;
  interimTranscript: string;
  supported: boolean;
  error: string | null;
  requiresNetwork: boolean;
  startListening: () => void;
  stopListening: () => void;
  clearTranscript: () => void;
}

// Fatal errors that should prevent auto-restart
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const accumulatedTranscriptRef = useRef('');
  const shouldRestartRef = useRef(false);
  const hadFatalErrorRef = useRef(false);

  // Check for SpeechRecognition support on mount
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSupported(!!SpeechRecognition);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.stop();
        } catch (_) {
          // Ignore errors during cleanup
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const createRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = '';
      let interim = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) {
            finalText += (finalText ? ' ' : '') + text;
          }
        } else {
          interim += result[0].transcript;
        }
      }

      // Append any new final text to the accumulated transcript
      if (finalText) {
        const sep = accumulatedTranscriptRef.current ? ' ' : '';
        accumulatedTranscriptRef.current += sep + finalText;
        console.log(`[STT] Final segment: "${finalText}" | Accumulated: "${accumulatedTranscriptRef.current}"`);
      }

      // Transcript = everything accumulated so far
      setTranscript(accumulatedTranscriptRef.current);
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.log(`[STT] Error: ${event.error} — ${event.message}`);

      if (FATAL_ERRORS.has(event.error)) {
        hadFatalErrorRef.current = true;
        shouldRestartRef.current = false;
      }

      switch (event.error) {
        case 'not-allowed':
          setError('Microphone access denied');
          break;
        case 'network':
          setError('Network error — speech recognition requires internet');
          break;
        case 'no-speech':
          // Normal during pauses — don't prevent restart
          break;
        case 'aborted':
          // User stopped — ignore
          break;
        default:
          setError(event.error || 'Speech recognition error');
          break;
      }
    };

    recognition.onend = () => {
      console.log(`[STT] Recognition ended, shouldRestart=${shouldRestartRef.current}, fatalError=${hadFatalErrorRef.current}`);
      setInterimTranscript('');

      if (shouldRestartRef.current && !hadFatalErrorRef.current) {
        // Small delay to avoid rapid restart loops
        setTimeout(() => {
          if (!shouldRestartRef.current) return;
          console.log('[STT] Auto-restarting recognition');
          const newRecognition = createRecognition();
          if (newRecognition) {
            recognitionRef.current = newRecognition;
            try {
              newRecognition.start();
              console.log('[STT] Recognition restarted successfully');
            } catch (err) {
              console.log(`[STT] Failed to restart: ${err}`);
              setListening(false);
              shouldRestartRef.current = false;
            }
          } else {
            setListening(false);
            shouldRestartRef.current = false;
          }
        }, 100);
      } else {
        setListening(false);
      }
    };

    return recognition;
  }, []);

  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // Stop any existing instance
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {
        // Ignore
      }
    }

    setError(null);
    accumulatedTranscriptRef.current = '';
    hadFatalErrorRef.current = false;
    shouldRestartRef.current = true;
    console.log('[STT] Starting speech recognition');

    const recognition = createRecognition();
    if (!recognition) return;

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setListening(true);
      console.log('[STT] Recognition started successfully');
    } catch (err) {
      console.log(`[STT] Failed to start: ${err}`);
      setError('Failed to start speech recognition');
      shouldRestartRef.current = false;
    }
  }, [createRecognition]);

  const stopListening = useCallback(() => {
    console.log('[STT] Stopping speech recognition');
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {
        // Ignore
      }
    }
    setListening(false);
  }, []);

  const clearTranscript = useCallback(() => {
    accumulatedTranscriptRef.current = '';
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    listening,
    transcript,
    interimTranscript,
    supported,
    error,
    requiresNetwork: true,
    startListening,
    stopListening,
    clearTranscript,
  };
}
