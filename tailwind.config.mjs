import { readFileSync } from 'node:fs';

/**
 * Paleta e tokens visuais vêm de src/data/theme.json — trocar lá re-skina o site.
 */
function loadTheme() {
  try {
    return JSON.parse(readFileSync(new URL('./src/data/theme.json', import.meta.url), 'utf-8'));
  } catch {
    return { colors: {}, radius: '2px' };
  }
}
const theme = loadTheme();

/**
 * `agua` (cor de acento) vira variável CSS pra poder ser trocada em runtime
 * (?accent=<chave>, ver src/middleware.ts + src/components/ThemeVars.astro).
 * `wash` também é variável (mesmo não sendo sobrescrita) pra manter os 4 tons
 * consistentes; DEFAULT/light/dark/wash guardam "R G B" em --agua-*, definidos
 * pelo ThemeVars no <head> — sem isso a cor cai em preto/transparente.
 */
const aguaVars = {
  DEFAULT: 'rgb(var(--agua-default) / <alpha-value>)',
  light: 'rgb(var(--agua-light) / <alpha-value>)',
  dark: 'rgb(var(--agua-dark) / <alpha-value>)',
  wash: 'rgb(var(--agua-wash) / <alpha-value>)',
};

/**
 * Fundo (bone) e texto (ink) também viram variável: o modo escuro da área
 * administrativa troca só os valores (html.admin-dark em global.css). Os
 * valores claros saem do theme.json via ThemeVars.
 */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const boneVars = { DEFAULT: v('bone'), 50: v('bone-50'), 100: v('bone-100'), 200: v('bone-200'), 300: v('bone-300') };
const inkVars = { DEFAULT: v('ink'), soft: v('ink-soft'), muted: v('ink-muted') };

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
  theme: {
    extend: {
      colors: { ...theme.colors, agua: aguaVars, bone: boneVars, ink: inkVars },
      fontFamily: {
        // Famílias em theme.json > fonts.{display,sans,accent}.
        // Os @font-face vêm do src/styles/global.css (fontsource).
        display: theme.fonts?.display ?? ['"Fraunces Variable"', 'Fraunces', 'Georgia', 'serif'],
        sans: theme.fonts?.sans ?? ['"Hanken Grotesk Variable"', '"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        // Fonte de "rótulo" (adesivos, etiquetas, marquee). Fallback pra display.
        accent: theme.fonts?.accent ??
          theme.fonts?.display ?? ['"Fraunces Variable"', 'Fraunces', 'Georgia', 'serif'],
      },
      fontSize: {
        eyebrow: ['0.72rem', { lineHeight: '1.1', letterSpacing: '0.22em' }],
      },
      letterSpacing: {
        eyebrow: '0.22em',
      },
      maxWidth: {
        prose: '68ch',
      },
      borderRadius: {
        card: theme.radius ?? '2px',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'drawer-in': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.6s cubic-bezier(0.22, 1, 0.36, 1) both',
        'drawer-in': 'drawer-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
