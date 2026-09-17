import { useState, useEffect, useRef, useCallback } from 'react';

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognitionInstance };
    webkitSpeechRecognition?: { new (): SpeechRecognitionInstance };
  }
}

export interface UseVoiceInputOptions {
  onTranscriptChange?: (transcript: string, isFinal: boolean) => void;
  onSpeechEnd?: (finalTranscript: string) => void;
  silenceTimeoutMs?: number;
}

export interface UseVoiceInputReturn {
  isSupported: boolean;
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;
  resetTranscript: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onTranscriptChange, onSpeechEnd, silenceTimeoutMs = 0 } = options;
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef('');
  const shouldBeListeningRef = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
      setIsSupported(Boolean(SpeechRecognitionClass));
    }
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopListening = useCallback(() => {
    clearSilenceTimer();
    clearRestartTimer();
    shouldBeListeningRef.current = false;
    setIsListening(false);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
  }, [clearRestartTimer, clearSilenceTimer]);

  const startListening = useCallback(() => {
    if (typeof window === 'undefined') return;
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setError('Speech recognition is not supported in this browser.');
      return;
    }

    clearSilenceTimer();
    clearRestartTimer();
    setError(null);
    setTranscript('');
    setInterimTranscript('');
    finalTranscriptRef.current = '';
    shouldBeListeningRef.current = true;

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = '';
        let currentFinal = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res) {
            const part = res[0]?.transcript || '';
            if (res.isFinal) {
              currentFinal += part;
            } else {
              interim += part;
            }
          }
        }

        if (currentFinal) {
          finalTranscriptRef.current = finalTranscriptRef.current
            ? `${finalTranscriptRef.current} ${currentFinal.trim()}`
            : currentFinal.trim();
        }

        const combined = finalTranscriptRef.current
          ? interim
            ? `${finalTranscriptRef.current} ${interim.trim()}`
            : finalTranscriptRef.current
          : interim.trim();

        setTranscript(finalTranscriptRef.current);
        setInterimTranscript(interim);

        onTranscriptChange?.(combined, false);

        clearSilenceTimer();
        if (combined.trim().length > 0 && silenceTimeoutMs > 0) {
          silenceTimerRef.current = setTimeout(() => {
            if (shouldBeListeningRef.current) {
              const textToSend = (finalTranscriptRef.current + (interim ? ' ' + interim : '')).trim();
              stopListening();
              if (textToSend) {
                onTranscriptChange?.(textToSend, true);
                onSpeechEnd?.(textToSend);
              }
            }
          }, silenceTimeoutMs);
        }
      };

      recognition.onerror = (event: { error: string; message?: string }) => {
        if (event.error === 'no-speech') {
          return;
        }
        if (event.error === 'not-allowed') {
          shouldBeListeningRef.current = false;
          setIsListening(false);
          setError('Microphone access was denied. Please allow microphone permissions.');
          return;
        }
        if (event.error === 'aborted') {
          return;
        }
        if (!shouldBeListeningRef.current) {
          setIsListening(false);
          setError(`Speech recognition error: ${event.error}`);
        }
      };

      recognition.onend = () => {
        clearSilenceTimer();
        if (shouldBeListeningRef.current) {
          clearRestartTimer();
          try {
            recognition.start();
            return;
          } catch {
            restartTimerRef.current = setTimeout(() => {
              if (shouldBeListeningRef.current && recognitionRef.current) {
                try {
                  recognitionRef.current.start();
                } catch {}
              }
            }, 200);
            return;
          }
        }

        setIsListening(false);
        const finalRecorded = finalTranscriptRef.current.trim();
        if (finalRecorded) {
          onTranscriptChange?.(finalRecorded, true);
          onSpeechEnd?.(finalRecorded);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      setError(err?.message || 'Could not start speech recognition');
      setIsListening(false);
      shouldBeListeningRef.current = false;
    }
  }, [clearRestartTimer, clearSilenceTimer, onSpeechEnd, onTranscriptChange, silenceTimeoutMs, stopListening]);

  const toggleListening = useCallback(() => {
    if (shouldBeListeningRef.current) {
      stopListening();
    } else {
      startListening();
    }
  }, [startListening, stopListening]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    finalTranscriptRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      clearSilenceTimer();
      clearRestartTimer();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
    };
  }, [clearRestartTimer, clearSilenceTimer]);

  return {
    isSupported,
    isListening,
    transcript,
    interimTranscript,
    error,
    startListening,
    stopListening,
    toggleListening,
    resetTranscript,
  };
}
