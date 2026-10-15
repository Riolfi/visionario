/**
 * Pop-up de confirmação no visual da loja (no lugar do confirm() do navegador).
 * Usa <dialog> nativo: Esc e clique fora cancelam. Resolve true só no botão
 * de confirmar.
 */
export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' (padrão, vermelho) ou 'primary' (escuro) */
  tone?: 'danger' | 'primary';
}): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.className =
    'w-[min(92vw,26rem)] rounded-card border border-ink/10 bg-bone p-0 text-ink shadow-xl backdrop:bg-ink/50';
  dialog.innerHTML = `
    <div class="p-6">
      <h2 class="font-display text-xl"></h2>
      <p class="mt-2 font-sans text-sm text-ink-soft" data-msg></p>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded-card border border-ink/20 px-4 py-2 font-sans text-sm hover:bg-bone-200"></button>
        <button type="button" data-ok class="rounded-card bg-red-700 px-4 py-2 font-sans text-sm text-white hover:bg-red-800"></button>
      </div>
    </div>`;
  // textContent: o nome do produto vem do banco, não vira HTML
  dialog.querySelector('h2')!.textContent = opts.title;
  const msg = dialog.querySelector<HTMLElement>('[data-msg]')!;
  if (opts.message) msg.textContent = opts.message;
  else msg.remove();
  dialog.querySelector('[data-cancel]')!.textContent = opts.cancelLabel ?? 'Cancelar';
  const ok = dialog.querySelector<HTMLElement>('[data-ok]')!;
  ok.textContent = opts.confirmLabel ?? 'Excluir';
  if (opts.tone === 'primary') ok.className = 'rounded-card bg-ink px-4 py-2 font-sans text-sm text-bone hover:bg-ink-soft';

  return new Promise((resolve) => {
    const close = (result: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    dialog.querySelector('[data-ok]')!.addEventListener('click', () => close(true));
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => close(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault(); // Esc
      close(false);
    });
    // clique no fundo escuro (fora da caixa) cancela
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) close(false);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.focus();
  });
}

/**
 * Pergunta padrão ao salvar (como em Produtos): "Deseja salvar como ativo/inativo?".
 * `fem` para palavras femininas (categoria, oferta, seção).
 */
export function askSaveActive(active: boolean, opts: { fem?: boolean; on: string; off: string }): Promise<boolean> {
  const word = active ? (opts.fem ? 'ativa' : 'ativo') : opts.fem ? 'inativa' : 'inativo';
  return confirmDialog({
    title: `Deseja salvar como ${word}?`,
    message: active ? opts.on : opts.off,
    confirmLabel: 'Sim',
    cancelLabel: 'Não',
    tone: 'primary',
  });
}
