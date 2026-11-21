import React, { useEffect, useRef, useState } from 'react';
import { Camera, X, RefreshCw, Barcode, Check } from 'lucide-react';
import { playScannerBeep } from '../services/audio';
import { DB } from '../services/db';
import { Product } from '../types';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
  title?: string;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onScan,
  title = 'مسح باركود المنتج',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);

  useEffect(() => {
    if (isOpen) {
      setAvailableProducts(DB.getProducts());
      startCamera();
    } else {
      stopCamera();
      setManualCode('');
      setCameraError(null);
    }
    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const startCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('الكاميرا غير مدعومة في هذا المتصفح');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setScanning(true);
        startBarcodeDetection();
      }
    } catch (err: unknown) {
      console.warn('Camera access denied or unavailable:', err);
      setCameraError('تعذر فتح الكاميرا (يرجى التأكد من إذن الكاميرا أو استخدام الإدخال اليدوي)');
    }
  };

  const stopCamera = () => {
    setScanning(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const handleDetected = (code: string) => {
    if (!code) return;
    playScannerBeep(true);
    stopCamera();
    onScan(code);
    onClose();
  };

  const startBarcodeDetection = () => {
    // Check if BarcodeDetector is available natively
    if ('BarcodeDetector' in window) {
      const barcodeDetector = new (window as any).BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e'],
      });

      const interval = setInterval(async () => {
        if (!videoRef.current || !streamRef.current) {
          clearInterval(interval);
          return;
        }
        try {
          if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
            const barcodes = await barcodeDetector.detect(videoRef.current);
            if (barcodes.length > 0) {
              const detected = barcodes[0].rawValue;
              if (detected) {
                clearInterval(interval);
                handleDetected(detected);
              }
            }
          }
        } catch {
          // Ignore detection frame error
        }
      }, 300);

      return () => clearInterval(interval);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/75 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto overscroll-contain">
      <div className="relative m-auto w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Barcode className="h-5 w-5 text-[var(--brand-primary)]" />
            <h3 className="app-section-title text-[17px]">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl h-10 w-10 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Viewfinder area */}
        <div className="relative bg-slate-950 flex flex-col items-center justify-center min-h-[260px] overflow-hidden">
          {cameraError ? (
            <div className="p-6 text-center text-slate-300 space-y-3">
              <Camera className="mx-auto h-12 w-12 text-slate-500" />
              <p className="text-sm font-medium">{cameraError}</p>
              <button
                onClick={startCamera}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
              >
                <RefreshCw className="h-3.5 w-3.5" /> إعادة المحاولة
              </button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-64 w-full object-cover"
              />
              {/* Overlay Laser Box */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-44 w-64 rounded-xl border-2 border-teal-400/80 bg-teal-500/5 shadow-[0_0_20px_rgba(20,184,166,0.3)]">
                  {/* Corner accents */}
                  <div className="absolute -top-1 -left-1 h-4 w-4 border-t-4 border-l-4 border-teal-400" />
                  <div className="absolute -top-1 -right-1 h-4 w-4 border-t-4 border-r-4 border-teal-400" />
                  <div className="absolute -bottom-1 -left-1 h-4 w-4 border-b-4 border-l-4 border-teal-400" />
                  <div className="absolute -bottom-1 -right-1 h-4 w-4 border-b-4 border-r-4 border-teal-400" />
                  
                  {/* Scanning Laser Line */}
                  <div className="absolute left-0 right-0 h-0.5 bg-red-500 shadow-[0_0_8px_#ef4444] animate-pulse top-1/2 -translate-y-1/2" />
                </div>
              </div>
              <p className="absolute bottom-2 text-center text-xs text-white/80 bg-black/60 px-3 py-1 rounded-full">
                وجّه الكاميرا نحو الباركود للمسح التلقائي
              </p>
            </>
          )}
        </div>

        {/* Manual Code Input & Quick Pick */}
        <div className="p-4 space-y-3.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (manualCode.trim()) {
                handleDetected(manualCode.trim());
              }
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="أو أدخل رقم الباركود يدويًا..."
              className="app-input flex-1 app-num"
              dir="ltr"
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              className="app-btn-primary px-4 shrink-0"
            >
              <Check className="h-4 w-4" />
              تأكيد
            </button>
          </form>

          {/* Quick Barcode Demo Pickers (only products that actually have a barcode) */}
          <div>
            <span className="text-[13px] font-bold text-[var(--text-secondary)]">اختر باركود مسجل سريع:</span>
            <div className="mt-2 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {(() => {
                const barcodedProducts = availableProducts
                  .filter((p) => Boolean(p.barcode && p.barcode.trim()))
                  .slice(0, 6);
                if (barcodedProducts.length === 0) {
                  return (
                    <span className="text-[13px] text-[var(--text-muted)]">
                      لا توجد منتجات تحتوي على باركود مسجل حالياً
                    </span>
                  );
                }
                return barcodedProducts.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleDetected(p.barcode)}
                    type="button"
                    className="min-h-[38px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-1.5 text-[13px] font-semibold text-[var(--text-primary)] hover:border-[var(--brand-primary)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-soft-text)] transition flex items-center gap-1.5 cursor-pointer"
                  >
                    <Barcode className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                    <span>{p.name.split(' ')[0]}</span>
                    <span className="app-num text-[11px] text-[var(--text-muted)]">({p.barcode.slice(-4)})</span>
                  </button>
                ));
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
