import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API wrapper. Chrome/Edge native; Safari is partial; Firefox unsupported.
// Returns { supported, listening, interim, transcript, start, stop, reset, error }.
// `transcript` accumulates final results across start/stop cycles until reset.
export function useSpeechRecognition({ lang = 'en-US', continuous = true, interimResults = true } = {}) {
  const SR =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;
  const supported = !!SR;
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supported) return undefined;
    const recognition = new SR();
    recognition.lang = lang;
    recognition.continuous = continuous;
    recognition.interimResults = interimResults;

    recognition.onresult = (event) => {
      let finalAdd = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalAdd += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (finalAdd) {
        setTranscript((prev) => (prev ? `${prev.trim()} ${finalAdd.trim()}` : finalAdd.trim()));
      }
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      setError(event.error || 'speech-recognition-error');
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      setInterim('');
    };

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.stop();
      } catch {
        /* noop */
      }
      recognitionRef.current = null;
    };
  }, [SR, supported, lang, continuous, interimResults]);

  const start = useCallback(() => {
    if (!supported || !recognitionRef.current) return;
    setError(null);
    try {
      recognitionRef.current.start();
      setListening(true);
    } catch (err) {
      // start() throws if already started — surface as a no-op
      setError(err.message || 'start-failed');
    }
  }, [supported]);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {
      /* noop */
    }
    setListening(false);
  }, []);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
  }, []);

  return { supported, listening, interim, transcript, start, stop, reset, error };
}
