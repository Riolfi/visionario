import { confirmDialog } from './confirm-dialog';

/**
 * Formulários com data-confirm="Título|Mensagem|Botão[|Cancelar[|primary]]"
 * pedem confirmação (pop-up da loja) antes de enviar.
 */
export function enableConfirmForms() {
  document.querySelectorAll<HTMLFormElement>('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      if (form.dataset.confirmed) return;
      e.preventDefault();
      const [title, message, confirmLabel, cancelLabel, tone] = form.dataset.confirm!.split('|');
      if (
        await confirmDialog({
          title: title!,
          message: message || undefined,
          confirmLabel,
          cancelLabel: cancelLabel || undefined,
          tone: tone === 'primary' ? 'primary' : undefined,
        })
      ) {
        form.dataset.confirmed = '1';
        form.requestSubmit();
      }
    });
  });
}
