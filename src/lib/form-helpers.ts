/**
 * Ajudas dos formulários (vanilla, para telas Astro):
 *  - olho para mostrar/ocultar senha ([data-pw-toggle] logo após o input);
 *  - e-mail validado ao sair do campo + "Confirmar e-mail" igual, com aviso
 *    embaixo e o botão de salvar desabilitado enquanto estiver errado.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function enablePasswordToggles(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('[data-pw-toggle]').forEach((btn) => {
    const input = btn.parentElement?.querySelector<HTMLInputElement>('input');
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.dataset.shown = show ? '1' : '';
      btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
      btn.setAttribute('aria-pressed', String(show));
    });
  });
}

/**
 * E-mail + confirmação. A confirmação só é exigida quando o e-mail é novo
 * ou mudou (initial = e-mail atual). Devolve uma função que diz se está ok.
 */
export function enableEmailConfirm(opts: {
  email: HTMLInputElement;
  confirm: HTMLInputElement;
  emailNotice: HTMLElement;
  confirmNotice: HTMLElement;
  submit?: HTMLButtonElement | null;
  initial?: string;
  /** esconde a confirmação enquanto o e-mail não mudou */
  confirmWrap?: HTMLElement | null;
}) {
  const { email, confirm, emailNotice, confirmNotice, submit, confirmWrap } = opts;
  const initial = (opts.initial ?? '').trim().toLowerCase();
  let touched = false;
  let confirmTouched = false;
  const changed = () => email.value.trim().toLowerCase() !== initial;

  const check = () => {
    const v = email.value.trim();
    const validEmail = EMAIL_RE.test(v);
    const needConfirm = changed();
    const same = !needConfirm || confirm.value.trim().toLowerCase() === v.toLowerCase();
    confirmWrap?.classList.toggle('hidden', !needConfirm);
    confirm.required = needConfirm;
    emailNotice.classList.toggle('hidden', !touched || validEmail);
    confirmNotice.classList.toggle('hidden', !confirmTouched || !needConfirm || same);
    const ok = validEmail && same;
    if (submit) submit.disabled = !ok;
    email.setCustomValidity(validEmail ? '' : 'E-mail inválido.');
    confirm.setCustomValidity(same ? '' : 'Os e-mails não conferem.');
    return ok;
  };
  email.addEventListener('blur', () => ((touched = true), check()));
  email.addEventListener('input', check);
  confirm.addEventListener('blur', () => ((confirmTouched = true), check()));
  confirm.addEventListener('input', () => (confirmTouched && check(), check()));
  // não deixa colar na confirmação (tem que digitar de novo)
  confirm.addEventListener('paste', (e) => e.preventDefault());
  check();
  return check;
}
