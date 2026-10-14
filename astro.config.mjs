// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import preact from '@astrojs/preact';
import vercel from '@astrojs/vercel';

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const SITE_URL =
  process.env.SITE_URL || process.env.PUBLIC_SITE_URL || (vercelUrl && `https://${vercelUrl}`) || 'http://localhost:4321';

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  output: 'server',
  // O checkOrigin padrão do Astro bloqueia POST de formulário (login,
  // uploads) quando o header Origin do navegador não bate com a URL da
  // request — o que acontece na prática atrás do proxy da Vercel ("Cross-site
  // POST form submissions are forbidden" no /api/auth/login). Mesma correção
  // da Iarah: a defesa real contra CSRF nas rotas autenticadas é o
  // SameSite=Lax dos cookies de sessão (cross-site POST não leva o cookie).
  security: { checkOrigin: false },
  adapter: vercel({
    webAnalytics: { enabled: false },
    imageService: true,
  }),
  integrations: [
    tailwind({ applyBaseStyles: false }),
    preact({ compat: true }),
  ],
  image: {
    domains: ['images.unsplash.com', 'plus.unsplash.com'],
    remotePatterns: [{ protocol: 'https' }],
  },
});
