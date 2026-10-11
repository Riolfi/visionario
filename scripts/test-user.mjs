/**
 * Conta de CLIENTE de teste, para o dono ver a loja como cliente (a conta de
 * administrador só acessa o painel).
 *
 *   npm run test-user                 gera uma senha nova para cliente@visionario.com.br (ou cria a conta)
 *   npm run test-user -- outro@email  usa outro e-mail
 *
 * A senha é gerada na hora e aparece só no terminal. Só roda num banco marcado
 * como da Visionário (store_identity, migration 0011).
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('✗ Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.');
  process.exit(1);
}
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: ident, error: identErr } = await sb.from('store_identity').select('store').maybeSingle();
if (identErr) die(`store_identity: ${identErr.message}`);
if (ident?.store !== 'visionario') die('este banco não está marcado como da Visionário. Nada foi alterado.');

const email = (process.argv[2] || 'cliente@visionario.com.br').toLowerCase();
const password = randomBytes(9).toString('base64url'); // 12 caracteres

// listUsers não filtra por e-mail; a loja tem poucas contas, uma página basta
const { data: list, error: listErr } = await sb.auth.admin.listUsers({ perPage: 1000 });
if (listErr) die(listErr.message);
const existing = list.users.find((u) => u.email?.toLowerCase() === email);

let userId;
if (existing) {
  const { error } = await sb.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  if (error) die(error.message);
  userId = existing.id;
  console.log('✓ conta já existia — senha nova gerada');
} else {
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Cliente Teste' },
  });
  if (error) die(error.message);
  userId = data.user.id;
  console.log('✓ conta criada');
}

// conta de teste é cliente: se alguém a promoveu a admin, ela não serviria pra ver a loja
const { data: adminRow } = await sb.from('admin_users').select('user_id').eq('user_id', userId).maybeSingle();
if (adminRow) die('essa conta está em admin_users — use outro e-mail para o cliente de teste.');

console.log(`\n  e-mail: ${email}\n  senha:  ${password}\n\nGuarde a senha: ela não fica salva em lugar nenhum.`);
