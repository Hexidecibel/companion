import { useState, useMemo } from 'react';
import type { ConversationHighlight } from '../types';
import { useVoiceMode } from '../hooks/useVoiceMode';
import { prepareForSpeech } from '../utils/ttsPrep';

interface VoiceModeProps {
  highlights: ConversationHighlight[];
  status: { isWaitingForInput: boolean; isRunning: boolean } | null;
  sendInput: (text: string) => Promise<boolean>;
  onClose: () => void;
}

const RATES = [0.75, 1, 1.25, 1.5];

export function VoiceMode({ highlights, status, sendInput, onClose }: VoiceModeProps) {
  const vm = useVoiceMode(highlights, sendInput, status);
  const [rateIndex, setRateIndex] = useState(() => RATES.indexOf(vm.rate) >= 0 ? RATES.indexOf(vm.rate) : 1);

  // Show the message at currentReadIndex if set, otherwise fall back to last assistant message
  const displayMessage = useMemo(() => {
    if (vm.currentReadIndex >= 0 && vm.currentReadIndex < vm.assistantMessages.length) {
      return vm.assistantMessages[vm.currentReadIndex];
    }
    // Fall back to last assistant message
    return vm.assistantMessages.length > 0
      ? vm.assistantMessages[vm.assistantMessages.length - 1]
      : null;
  }, [vm.currentReadIndex, vm.assistantMessages]);

  const displayText = useMemo(() => {
    if (!displayMessage) return null;
    return prepareForSpeech(displayMessage.content);
  }, [displayMessage]);

  const statusLabel = status?.isWaitingForInput
    ? 'Waiting'
    : status?.isRunning
      ? 'Working'
      : 'Idle';

  const statusClass = status?.isWaitingForInput
    ? 'voice-badge-amber'
    : status?.isRunning
      ? 'voice-badge-blue'
      : 'voice-badge-gray';

  const handleCycleRate = () => {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    vm.setRate(RATES[next]);
  };

  const handleMicToggle = () => {
    if (!vm.sttSupported) return;
    if (vm.listening) {
      vm.stopListening();
    } else {
      vm.startListening();
    }
  };

  const handleSend = async () => {
    await vm.sendVoiceInput();
  };

  const handlePlayPause = () => {
    if (vm.speaking && !vm.paused) {
      vm.pause();
    } else if (vm.paused) {
      vm.resume();
    } else {
      vm.readCurrentMessage();
    }
  };

  const handleSkipPrev = () => {
    console.log('[Voice] Skip prev button pressed');
    vm.skipMessage('prev');
  };

  const handleSkipNext = () => {
    console.log('[Voice] Skip next button pressed');
    vm.skipMessage('next');
  };

  const playPauseLabel = vm.speaking && !vm.paused
    ? 'Pause'
    : vm.paused
      ? 'Resume'
      : 'Play';

  // Message position indicator
  const positionLabel = vm.assistantMessageCount > 0
    ? `Message ${(vm.currentReadIndex >= 0 ? vm.currentReadIndex : vm.assistantMessageCount - 1) + 1} of ${vm.assistantMessageCount}`
    : null;

  // Status line text
  let statusLineText = 'Ready';
  let statusLineClass = '';
  if (vm.error) {
    statusLineText = vm.error;
    statusLineClass = 'voice-status-error';
  } else if (vm.speaking && !vm.paused) {
    statusLineText = 'Speaking...';
  } else if (vm.handsFree && vm.listening) {
    statusLineText = 'Hands-free: listening...';
  } else if (vm.listening) {
    statusLineText = 'Listening...';
  } else if (vm.paused) {
    statusLineText = 'Paused';
  }

  return (
    <div className="voice-mode-overlay">
      {/* Header */}
      <div className="voice-mode-header">
        <span className="voice-mode-title">Voice Mode</span>
        <span className={`voice-mode-status-badge ${statusClass}`}>{statusLabel}</span>
        <div style={{ flex: 1 }} />
        <button className="voice-ctrl-btn" onClick={onClose} title="Close voice mode">X</button>
      </div>

      {/* Message display */}
      <div className="voice-mode-message">
        {displayText ? (
          <div className="voice-message-content">
            {positionLabel && (
              <div className="voice-message-position">{positionLabel}</div>
            )}
            <p>{displayText}</p>
            {!vm.speaking && (
              <button
                className="voice-ctrl-btn voice-read-btn"
                onClick={() => vm.readCurrentMessage()}
              >
                Read aloud
              </button>
            )}
          </div>
        ) : (
          <p className="voice-message-empty">No messages yet</p>
        )}
      </div>

      {/* TTS controls */}
      <div className="voice-mode-tts-controls">
        {vm.ttsSupported ? (
          <>
            <button className="voice-ctrl-btn" onClick={handlePlayPause}>
              {playPauseLabel}
            </button>
            <button className="voice-ctrl-btn" onClick={vm.stop} disabled={!vm.speaking && !vm.paused}>
              Stop
            </button>
            <button
              className="voice-ctrl-btn"
              onClick={handleSkipPrev}
              disabled={vm.currentReadIndex <= 0 && vm.assistantMessageCount <= 1}
              title="Skip to previous message"
            >
              Prev
            </button>
            <button
              className="voice-ctrl-btn"
              onClick={handleSkipNext}
              disabled={vm.currentReadIndex >= vm.assistantMessageCount - 1}
              title="Skip to next message"
            >
              Next
            </button>
            <button
              className={`voice-ctrl-btn ${vm.autoRead ? 'active' : ''}`}
              onClick={vm.toggleAutoRead}
            >
              Auto
            </button>
            <button
              className={`voice-ctrl-btn ${vm.handsFree ? 'active' : ''}`}
              onClick={vm.toggleHandsFree}
            >
              Hands-free
            </button>
            <button className="voice-ctrl-btn" onClick={handleCycleRate}>
              {RATES[rateIndex]}x
            </button>
          </>
        ) : (
          <span className="voice-unsupported-note">Text-to-speech is not available on this device</span>
        )}
      </div>

      {/* STT section */}
      <div className="voice-mode-stt-section">
        {vm.sttSupported ? (
          <>
            <button
              className={`voice-mic-btn ${vm.listening ? 'listening' : ''}`}
              onClick={handleMicToggle}
              title={vm.listening ? 'Stop listening' : 'Start listening'}
            >
              MIC
            </button>

            <div className="voice-transcript">
              {vm.transcript || vm.interimTranscript ? (
                <>
                  {vm.transcript && <span>{vm.transcript}</span>}
                  {vm.interimTranscript && (
                    <span className="voice-transcript-interim"> {vm.interimTranscript}</span>
                  )}
                </>
              ) : (
                <span className="voice-transcript-placeholder">Tap microphone to speak</span>
              )}
            </div>

            {(vm.transcript) && (
              <div className="voice-mode-actions">
                <button className="voice-ctrl-btn voice-send-btn" onClick={handleSend}>
                  Send
                </button>
                <button className="voice-ctrl-btn" onClick={vm.clearTranscript}>
                  Clear
                </button>
              </div>
            )}

            {vm.requiresNetwork && (
              <p className="voice-privacy-note">Speech is processed by Google</p>
            )}
          </>
        ) : (
          <div className="voice-unsupported-note">
            Speech recognition not available on this device
          </div>
        )}
      </div>

      {/* Status line */}
      <div className={`voice-mode-status-line ${statusLineClass}`}>
        {statusLineText}
      </div>
    </div>
  );
}
