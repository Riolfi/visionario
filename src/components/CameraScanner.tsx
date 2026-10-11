import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Leitor de código de barras pela câmera do celular (Caixa no mobile).
 *
 * - Usa o BarcodeDetector nativo quando o navegador tem (Chrome/Android);
 *   senão carrega o ZXing sob demanda (Safari/iPhone) — o pacote só é
 *   baixado quando a câmera abre, não pesa no Caixa normal.
 * - Lê vários produtos seguidos. O mesmo código só conta de novo depois de
 *   SAIR da frente da câmera por GONE_MS — câmera parada em cima de um
 *   produto não fica somando unidade; pra 2 iguais, tira e passa de novo.
 * - Câmera exige HTTPS (ou localhost) e permissão do usuário.
 */

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const GONE_MS = 900;

interface Props {
  onCode: (code: string) => void;
  onClose: () => void;
  /** última mensagem do Caixa ("X adicionado", "não cadastrado") */
  status?: { tone: 'ok' | 'warn' | 'err'; text: string } | null;
}

type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1500;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => ctx.close();
  } catch {
    /* sem áudio, segue só a vibração */
  }
  navigator.vibrate?.(60);
}

export default function CameraScanner({ onCode, onClose, status }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let zxingStop: (() => void) | null = null;
    const last = { code: '', seen: 0 };

    const found = (raw: string) => {
      const code = raw.trim();
      const now = Date.now();
      if (!code) return;
      const sameStillInView = code === last.code && now - last.seen < GONE_MS;
      last.code = code;
      last.seen = now;
      if (sameStillInView) return;
      beep();
      onCodeRef.current(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este navegador não dá acesso à câmera. Use o campo de código.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Permissão da câmera negada. Libere a câmera para este site nas configurações do navegador.'
            : name === 'NotFoundError'
              ? 'Nenhuma câmera encontrada neste aparelho.'
              : 'Não foi possível abrir a câmera.',
        );
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setReady(true);

      const Native = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
      const nativeFormats = Native ? await Native.getSupportedFormats?.().catch(() => []) : [];
      if (Native && nativeFormats?.includes('ean_13')) {
        const detector = new Native({ formats: FORMATS.filter((f) => nativeFormats.includes(f)) });
        let busy = false;
        let lastTick = 0;
        const tick = (t: number) => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (busy || t - lastTick < 120 || video.readyState < 2) return;
          lastTick = t;
          busy = true;
          detector
            .detect(video)
            .then((codes) => codes[0] && found(codes[0].rawValue))
            .catch(() => {})
            .finally(() => (busy = false));
        };
        raf = requestAnimationFrame(tick);
        return;
      }

      // Safari/iPhone e afins: ZXing, carregado só agora
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      if (stopped) return;
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
      ]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
      const controls = await reader.decodeFromVideoElement(video, (result) => {
        if (result) found(result.getText());
      });
      zxingStop = () => controls.stop();
      if (stopped) zxingStop();
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      zxingStop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Esc fecha (teclado em tablet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="fixed inset-0 z-[70] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Ler código de barras com a câmera">
      <div class="relative flex-1 overflow-hidden">
        <video ref={videoRef} class="absolute inset-0 h-full w-full object-cover" playsInline muted />
        {/* mira */}
        {ready && !error && (
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div class="relative h-[160px] w-[82vw] max-w-[380px] rounded-[18px] border-2 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]">
              <span class="absolute left-[16px] right-[16px] top-1/2 h-[2px] -translate-y-1/2 animate-pulse bg-red-500/80" />
            </div>
          </div>
        )}
        {!ready && !error && (
          <p class="absolute inset-0 flex items-center justify-center font-sans text-[15px] text-white/80">Abrindo a câmera…</p>
        )}
        {error && (
          <div class="absolute inset-0 flex items-center justify-center p-8">
            <p class="max-w-[300px] text-center font-sans text-[15px] leading-relaxed text-white">{error}</p>
          </div>
        )}
      </div>

      <div class="bg-black px-[20px] pb-[max(20px,env(safe-area-inset-bottom))] pt-[16px]">
        <p
          class={`mb-[12px] min-h-[22px] text-center font-sans text-[15px] ${
            !status ? 'text-white/70' : status.tone === 'ok' ? 'text-emerald-300' : status.tone === 'warn' ? 'text-amber-300' : 'text-red-300'
          }`}
          aria-live="polite"
        >
          {status ? status.text : 'Aponte para o código de barras do produto'}
        </p>
        <button type="button" onClick={onClose} class="w-full rounded-full bg-white py-[14px] font-sans text-[16px] font-semibold text-ink">
          Concluir leitura
        </button>
      </div>
    </div>
  );
}
