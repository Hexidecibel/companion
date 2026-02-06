import { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';

export interface QRConfig {
  host: string;
  port: number;
  token?: string;
  tls: boolean;
}

interface QRScannerModalProps {
  onScan: (config: QRConfig) => void;
  onClose: () => void;
}

export function QRScannerModal({ onScan, onClose }: QRScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let animationId: number;
    let active = true;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          scan();
        }
      } catch {
        setError('Camera access denied or unavailable.');
        setScanning(false);
      }
    }

    function scan() {
      if (!active || !scanning) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        animationId = requestAnimationFrame(scan);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        try {
          const config = JSON.parse(code.data) as QRConfig;
          if (config.host && config.port) {
            stopStream();
            onScan(config);
            return;
          }
        } catch {
          // Not valid JSON — keep scanning
        }
      }

      animationId = requestAnimationFrame(scan);
    }

    start();

    return () => {
      active = false;
      cancelAnimationFrame(animationId);
      stopStream();
    };
  }, [scanning, onScan, stopStream]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-header">
          <button className="icon-btn small" onClick={onClose}>&larr;</button>
          <h2>Scan QR Code</h2>
          <div className="header-spacer" />
        </div>
        <div className="qr-scanner-body">
          {error ? (
            <div className="qr-scanner-error">
              <p>{error}</p>
              <button className="btn-primary" onClick={onClose} style={{ maxWidth: 200 }}>
                Close
              </button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="qr-scanner-video" playsInline muted />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              <div className="qr-scanner-overlay">
                <div className="qr-scanner-frame" />
              </div>
              <p className="qr-scanner-hint">
                Point the camera at the QR code on your server
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
