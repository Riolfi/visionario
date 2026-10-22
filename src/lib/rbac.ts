/**
 * Controle de acesso da área administrativa.
 *
 *   Regra     → uma ação do sistema, conferida no SERVIDOR (middleware e APIs).
 *               Fixas no código: regra criada pela tela não protegeria nada.
 *   Permissão → grupo de regras de uma tela, editável em Permissões.
 *   Cargo     → conjunto de permissões, editável em Cargos; cada membro da
 *               equipe tem um. O cargo Administrador tem tudo; o e-mail do
 *               Proprietário (nele) decide quem dá/tira o cargo Administrador.
 *
 * Arquivo puro (sem banco), usado no servidor e nas telas.
 */

export const SCREENS = [
  { key: 'painel', label: 'Painel', href: '/admin', view: 'painel.ver' },
  { key: 'caixa', label: 'Caixa', href: '/admin/caixa', view: 'caixa.vender' },
  { key: 'produtos', label: 'Produtos', href: '/admin/produtos', view: 'produtos.ver' },
  { key: 'pedidos', label: 'Vendas', href: '/admin/pedidos', view: 'pedidos.ver' },
  { key: 'ofertas', label: 'Ofertas', href: '/admin/ofertas', view: 'ofertas.ver' },
  { key: 'categorias', label: 'Categorias', href: '/admin/categorias', view: 'categorias.ver' },
  { key: 'conteudo', label: 'Conteúdo', href: '/admin/site', view: 'conteudo.ver' },
  { key: 'usuarios', label: 'Usuários', href: '/admin/usuarios', view: null },
  { key: 'notificacoes', label: 'Notificações', href: '/admin/notificacoes', view: 'notificacoes.ver' },
] as const;
export type ScreenKey = (typeof SCREENS)[number]['key'];

export const RULES = [
  { key: 'painel.ver', screen: 'painel', label: 'Ver o painel', help: 'Resumo e vendas recentes.' },
  { key: 'caixa.vender', screen: 'caixa', label: 'Vender no Caixa', help: 'Abrir o Caixa, ler produtos e registrar vendas (dinheiro, cartão, Pix).' },
  { key: 'caixa.cancelar', screen: 'caixa', label: 'Cancelar vendas do Caixa', help: 'Cancela a venda e devolve os itens ao estoque.' },
  { key: 'produtos.ver', screen: 'produtos', label: 'Ver produtos', help: 'Lista e ficha dos produtos, sem alterar.' },
  { key: 'produtos.editar', screen: 'produtos', label: 'Cadastrar e editar produtos', help: 'Criar, alterar preço/estoque, enviar fotos e buscar nas bases públicas.' },
  { key: 'produtos.excluir', screen: 'produtos', label: 'Excluir produtos', help: 'Apagar produtos (ou desativar os que já foram vendidos).' },
  { key: 'pedidos.ver', screen: 'pedidos', label: 'Ver vendas', help: 'Lista e detalhes das vendas, com dados do cliente.' },
  { key: 'pedidos.status', screen: 'pedidos', label: 'Mudar status de vendas', help: 'Marcar como pago, enviado, entregue ou cancelado (mexe no estoque).' },
  { key: 'pedidos.cancelar', screen: 'pedidos', label: 'Cancelar vendas', help: 'Botão "Cancelar venda" no detalhe da venda (online ou do Caixa); devolve os itens ao estoque.' },
  { key: 'ofertas.ver', screen: 'ofertas', label: 'Ver ofertas', help: 'Carrossel da página inicial.' },
  { key: 'ofertas.editar', screen: 'ofertas', label: 'Editar ofertas', help: 'Criar, alterar e excluir banners do carrossel.' },
  { key: 'categorias.ver', screen: 'categorias', label: 'Ver categorias', help: 'Árvore de categorias.' },
  { key: 'categorias.editar', screen: 'categorias', label: 'Editar categorias', help: 'Criar, renomear, reordenar e excluir categorias.' },
  { key: 'conteudo.ver', screen: 'conteudo', label: 'Ver conteúdo do site', help: 'Textos editáveis da loja.' },
  { key: 'conteudo.editar', screen: 'conteudo', label: 'Editar conteúdo do site', help: 'Textos da loja, logo, rodapé, Sobre e Contato.' },
  { key: 'equipe.ver', screen: 'usuarios', label: 'Visualizar usuários', help: 'Ver a lista da equipe e a ficha de cada um (sem senha).' },
  { key: 'equipe.gerenciar', screen: 'usuarios', label: 'Criar/editar usuários', help: 'Criar usuários e editar o nome de quem não é Administrador. Senha, cargo, ativo e exclusão são só de Administradores.' },
  { key: 'clientes.ver', screen: 'usuarios', label: 'Ver clientes', help: 'Dados cadastrais, endereços e vendas dos clientes.' },
  { key: 'clientes.estado', screen: 'usuarios', label: 'Ativar, desativar e bloquear clientes', help: 'Muda o estado da conta, com motivo registrado.' },
  { key: 'notificacoes.ver', screen: 'notificacoes', label: 'Ver notificações', help: 'Avisos automáticos (estoque esgotado, pagamentos a conferir).' },
] as const;
export type RuleKey = (typeof RULES)[number]['key'];
export const RULE_KEYS = RULES.map((r) => r.key) as RuleKey[];
export const isRuleKey = (v: unknown): v is RuleKey => RULE_KEYS.includes(v as RuleKey);

export interface AdminAccess {
  /** cargo Administrador: acesso total, inclusive Permissões e Cargos */
  isOwner: boolean;
  roleId: string | null;
  roleName: string;
  rules: RuleKey[];
  /** membro da equipe desativado (0020): o login é recusado */
  inactive?: boolean;
}

export const can = (a: AdminAccess | null | undefined, rule: RuleKey) => !!a && (a.isOwner || a.rules.includes(rule));

/** Telas do menu que essa pessoa enxerga, na ordem. */
export function visibleScreens(a: AdminAccess) {
  return SCREENS.filter((s) =>
    // Painel: toda a equipe (é a tela de entrada); os números dependem de painel.ver
    s.key === 'painel' ? true : s.key === 'usuarios' ? can(a, 'equipe.ver') || can(a, 'clientes.ver') : can(a, s.view as RuleKey),
  );
}

/**
 * Pode abrir essa rota com esse método? Página = regra de ver; API = regra da
 * ação (GET lê, o resto altera). Ações dentro da mesma API (ex.: cancelar
 * venda do Caixa) são conferidas de novo no handler. Rota desconhecida em
 * /admin fica só para o Administrador (padrão seguro).
 */
export function canAccess(a: AdminAccess, pathname: string, method = 'GET'): boolean {
  if (a.isOwner) return true;
  const under = (...p: string[]) => p.some((x) => pathname === x || pathname.startsWith(x + '/'));
  const read = method === 'GET' || method === 'HEAD';
  const pick = (ver: RuleKey, editar: RuleKey) => can(a, read ? ver : editar);

  if (under('/admin/perfil', '/api/admin/profile')) return true;
  if (under('/admin/permissoes', '/api/admin/permissions')) return false;
  // Permissões e Cargos: só Administradores (já liberados no topo)
  if (under('/admin/cargos', '/api/admin/roles')) return false;
  // Configurações (Meios de pagamento): só Administradores; quem altera é o Proprietário (a tela confere)
  if (under('/admin/configuracoes', '/api/admin/payment-settings')) return false;
  if (under('/admin/notificacoes')) return can(a, 'notificacoes.ver');
  if (under('/admin/usuarios/clientes')) return can(a, 'clientes.ver');
  if (under('/admin/usuarios')) return can(a, 'equipe.ver') || can(a, 'clientes.ver');
  if (under('/api/admin/users')) return can(a, 'equipe.gerenciar');
  if (under('/api/admin/customers')) return can(a, 'clientes.estado');
  if (pathname === '/admin' || pathname === '/admin/') return true; // Painel: entrada de toda a equipe
  if (under('/admin/caixa', '/api/admin/caixa')) return can(a, 'caixa.vender');
  if (under('/api/admin/receipt')) return can(a, 'caixa.vender') || can(a, 'pedidos.ver');
  if (under('/api/admin/products/by-barcode')) return can(a, 'caixa.vender') || can(a, 'produtos.ver');
  if (under('/admin/produtos/novo', '/api/admin/products/lookup')) return can(a, 'produtos.editar');
  if (under('/api/admin/products')) return method === 'DELETE' ? can(a, 'produtos.excluir') : pick('produtos.ver', 'produtos.editar');
  if (under('/admin/produtos')) return can(a, 'produtos.ver');
  if (under('/admin/pedidos')) return can(a, 'pedidos.ver');
  if (under('/api/admin/orders/cancel')) return can(a, 'pedidos.cancelar');
  if (under('/api/admin/orders/devolucao')) return can(a, 'pedidos.cancelar');
  if (under('/api/admin/orders/cancel-request', '/api/admin/orders/stock')) return can(a, 'pedidos.cancelar');
  if (under('/api/admin/orders')) return pick('pedidos.ver', 'pedidos.status');
  if (under('/admin/ofertas')) return can(a, 'ofertas.ver');
  if (under('/api/admin/offers')) return pick('ofertas.ver', 'ofertas.editar');
  if (under('/admin/categorias')) return can(a, 'categorias.ver');
  if (under('/api/admin/categories')) return pick('categorias.ver', 'categorias.editar');
  if (under('/admin/site')) return can(a, 'conteudo.ver');
  if (under('/api/admin/site')) return pick('conteudo.ver', 'conteudo.editar');
  if (under('/api/admin/upload')) return can(a, 'produtos.editar') || can(a, 'ofertas.editar') || can(a, 'conteudo.editar');
  return false;
}

/** Primeira tela que essa pessoa pode abrir (sem acesso a nada: Meu perfil). */
export function homeFor(a: AdminAccess): string {
  return visibleScreens(a)[0]?.href ?? '/admin/perfil';
}
