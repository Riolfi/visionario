import { confirmDialog } from './confirm-dialog';

/**
 * Excluir produto pelo admin (lista e cadastro): confirma, apaga e, se o
 * produto já tem pedidos (não pode sumir do histórico), oferece desativar.
 * Devolve o que aconteceu, ou { error } com a mensagem para mostrar.
 */
export async function deleteProductFlow(
  id: string,
  name: string,
): Promise<'deleted' | 'deactivated' | 'cancelled' | { error: string }> {
  const ok = await confirmDialog({
    title: 'Excluir produto?',
    message: `"${name}" sai do catálogo. Isso não pode ser desfeito.`,
  });
  if (!ok) return 'cancelled';

  const res = await fetch(`/api/admin/products?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok) return 'deleted';
  const d = await res.json().catch(() => ({}));
  if (res.status !== 409 || !d.inUse) return { error: d.error || 'Erro ao excluir.' };

  const deactivate = await confirmDialog({
    title: 'Este produto já foi vendido',
    message: `"${name}" aparece em pedidos, então não pode ser excluído. Quer desativar? Ele some da loja, mas continua no histórico dos pedidos.`,
    confirmLabel: 'Desativar',
  });
  if (!deactivate) return 'cancelled';
  const r2 = await fetch(`/api/admin/products?id=${encodeURIComponent(id)}&deactivate=1`, { method: 'DELETE' });
  if (r2.ok) return 'deactivated';
  const d2 = await r2.json().catch(() => ({}));
  return { error: d2.error || 'Erro ao desativar.' };
}
