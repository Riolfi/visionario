import { useState } from 'preact/hooks';
import { confirmDialog } from '../lib/confirm-dialog';

/**
 * Rodapé padrão dos cadastros da área administrativa (igual a Produtos):
 * Salvar · Cancelar · Excluir, com as mesmas confirmações.
 *  - Cancelar: "Sair e perder alterações?" e volta para a lista;
 *  - Excluir num cadastro novo: "Descartar este cadastro?";
 *  - Excluir bloqueado (`deleteBlock`): o botão fica visível, apagado, e o
 *    clique mostra o motivo acima dos botões.
 */
export default function FormActions({
  listHref,
  saving,
  isNew,
  saveLabel = 'Salvar',
  deleteTitle,
  deleteMessage,
  onDelete,
  deleteBlock,
}: {
  listHref: string;
  saving: boolean;
  isNew: boolean;
  saveLabel?: string;
  deleteTitle: string;
  deleteMessage?: string;
  /** apaga de verdade (já confirmado aqui) */
  onDelete?: () => void | Promise<void>;
  /** motivo para não poder excluir (texto ou elemento com link) */
  deleteBlock?: preact.ComponentChildren;
}) {
  const [showBlock, setShowBlock] = useState(0);

  async function cancel() {
    if (await confirmDialog({ title: 'Sair e perder alterações?', confirmLabel: 'Sair', cancelLabel: 'Manter alterações' })) {
      window.location.href = listHref;
    }
  }

  async function remove() {
    if (deleteBlock) return setShowBlock((n) => n + 1);
    if (isNew) {
      const discard = await confirmDialog({ title: 'Descartar este cadastro?', message: 'Nada foi salvo ainda.', confirmLabel: 'Descartar' });
      if (discard) window.location.href = listHref;
      return;
    }
    if (await confirmDialog({ title: deleteTitle, message: deleteMessage ?? 'Isso não pode ser desfeito.' })) await onDelete?.();
  }

  return (
    <div class="space-y-3 pt-2">
      {deleteBlock && showBlock > 0 && (
        <p key={showBlock} role="alert" class="notice-in rounded-[14px] border border-red-200 bg-red-50 px-3 py-2 font-sans text-[13px] text-red-700">
          ! {deleteBlock}
        </p>
      )}
      <div class="grid grid-cols-3 gap-3">
        <button type="submit" class="btn-primary w-full" disabled={saving}>
          {saving ? 'Salvando…' : saveLabel}
        </button>
        <button type="button" onClick={cancel} class="btn-outline w-full">
          Cancelar
        </button>
        <button
          type="button"
          onClick={remove}
          class={`btn-outline w-full ${deleteBlock ? 'cursor-not-allowed opacity-40' : ''}`}
          aria-disabled={deleteBlock ? 'true' : undefined}
          disabled={saving}
        >
          Excluir
        </button>
      </div>
    </div>
  );
}

/** Aviso verde de "salvo" no topo (cadastro novo volta com ?salvo=1). */
export function SavedNotice({ text = 'Salvo com sucesso!' }: { text?: string }) {
  return (
    <p role="status" class="notice-in rounded-[14px] border border-green-200 bg-green-50 px-3 py-2 font-sans text-[13px] text-green-800">
      ✓ {text}
    </p>
  );
}
