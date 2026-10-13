import { useEffect, useState } from 'preact/hooks';
import CameraScanner from './CameraScanner';

/**
 * Botão "Ler com a câmera" de leitura ÚNICA: abre a câmera, entrega o
 * primeiro código lido e fecha. Aparece sempre (celular e PC), mas só fica
 * ativo quando o aparelho tem câmera — e se liga sozinho se uma webcam for
 * conectada depois. O Caixa usa CameraScanner direto, em modo contínuo.
 *
 * Sem onCode (ilha do Astro, que não recebe função): preenche o input
 * `targetId` e dispara Enter nele, reaproveitando o script da página.
 */
/** Estilo dos botões ao lado do campo de código ("Enviar" e "Abrir leitor"):
 *  mesma altura do .field (py-3 + 15px) e mesma largura entre si. */
export const SCAN_BTN =
  'inline-flex w-36 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-card border border-ink/20 bg-white/70 px-3 py-3 font-sans text-[15px] text-ink hover:bg-bone-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/70';

/** Ícone de check do botão "Enviar". */
export const CHECK_ICON_PATH = 'M5 12.5l4.5 4.5L19 7.5';

/** O aparelho tem câmera? Atualiza sozinho se uma webcam for (des)conectada. */
export function useHasCamera(): boolean {
  const [hasCamera, setHasCamera] = useState(false);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices || !md.getUserMedia) return; // sem câmera ou fora de https
    const check = () =>
      md.enumerateDevices().then((list) => setHasCamera(list.some((d) => d.kind === 'videoinput')), () => setHasCamera(false));
    check();
    md.addEventListener('devicechange', check);
    return () => md.removeEventListener('devicechange', check);
  }, []);
  return hasCamera;
}

/** Ícone do leitor de código de barras. */
export const SCAN_ICON_PATH = 'M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 9v6M10 9v6M13 9v6M16 9v6';

interface Props {
  onCode?: (code: string) => void;
  targetId?: string;
  class?: string;
}

export default function CameraScanButton({ onCode, targetId, class: cls = '' }: Props) {
  const [open, setOpen] = useState(false);
  const hasCamera = useHasCamera();

  const deliver = (code: string) => {
    setOpen(false);
    if (onCode) return onCode(code);
    const input = targetId ? (document.getElementById(targetId) as HTMLInputElement | null) : null;
    if (!input) return;
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!hasCamera}
        title={hasCamera ? 'Ler o código com a câmera' : 'Nenhuma câmera encontrada neste aparelho'}
        class={`${SCAN_BTN} ${cls}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 9v6M10 9v6M13 9v6M16 9v6" /></svg>
        Abrir leitor
      </button>
      {open && <CameraScanner onCode={deliver} onClose={() => setOpen(false)} closeLabel="Cancelar" />}
    </>
  );
}
