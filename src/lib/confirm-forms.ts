import { confirmDialog } from './confirm-dialog';

/**
 * Formulários com data-confirm="Título|Mensagem|Botão" pedem confirmação
 * (pop-up da loja) antes de enviar.
 */
export function enableConfirmForms() {
  document.querySelectorAll<HTMLFormElement>('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      if (form.dataset.confirmed) return;
      e.preventDefault();
      const [title, message, confirmLabel] = form.dataset.confirm!.split('|');
      if (await confirmDialog({ title: title!, message: message || undefined, confirmLabel })) {
        form.dataset.confirmed = '1';
        form.requestSubmit();
      }
    });
  });
}
