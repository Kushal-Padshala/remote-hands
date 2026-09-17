import React from 'react';

export interface VoiceButtonProps {
  isListening: boolean;
  isSupported?: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  showLabel?: boolean;
  title?: string;
}

export function VoiceButton({
  isListening,
  isSupported = true,
  onToggle,
  disabled = false,
  className = '',
  size = 'md',
  showLabel = false,
  title,
}: VoiceButtonProps) {
  const buttonTitle = title || (
    !isSupported
      ? 'Voice input not supported in this browser'
      : isListening
      ? 'Listening... Click to stop'
      : 'Click to speak your prompt'
  );

  return (
    <button
      type="button"
      className={`voice-btn ${size === 'sm' ? 'voice-btn-sm' : ''} ${isListening ? 'listening' : ''} ${!isSupported ? 'unsupported' : ''} ${className}`}
      onClick={onToggle}
      disabled={disabled || !isSupported}
      title={buttonTitle}
      aria-label={buttonTitle}
      data-testid="voice-prompt-btn"
    >
      {isListening ? (
        <span className="voice-btn-listening-content">
          <span className="voice-pulse-ring" />
          <svg
            className="voice-mic-icon active"
            width={size === 'sm' ? 16 : 18}
            height={size === 'sm' ? 16 : 18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          {showLabel && <span className="voice-btn-label">Listening...</span>}
        </span>
      ) : (
        <span className="voice-btn-idle-content">
          <svg
            className="voice-mic-icon"
            width={size === 'sm' ? 16 : 18}
            height={size === 'sm' ? 16 : 18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          {showLabel && <span className="voice-btn-label">Speak</span>}
        </span>
      )}
    </button>
  );
}
