import { issueCode } from './repo/email-codes';

/**
 * Troca de e-mail em dois passos: o código do e-mail ATUAL prova que é o dono
 * da conta; depois vai um segundo código ao e-mail NOVO, que prova que ele é
 * dono do endereço (sem isso, alguém poria o e-mail de outra pessoa na
 * própria conta — e um login pelo Google com esse e-mail cairia nela).
 */
export function sendNewEmailCode(userId: string, newEmail: string) {
  return issueCode({
    userId,
    purpose: 'email-new',
    newEmail,
    sendTo: newEmail,
    subject: 'Confirme o seu novo e-mail',
    intro: 'Para concluir a troca de e-mail da sua conta, use o código abaixo.',
  });
}
