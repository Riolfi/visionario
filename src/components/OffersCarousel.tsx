import { useEffect, useRef, useState } from 'preact/hooks';
import type { Offer } from '../lib/types';

const AUTOPLAY_MS = 6000;

function imgSrc(url: string, w: number): string {
  if (/unsplash\.com\//.test(url)) return `${url.split('?')[0]}?auto=format&fit=crop&q=70&w=${w}`;
  return url;
}

export default function OffersCarousel({ slides }: { slides: Offer[] }) {
  const list = slides.length ? slides : [];
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchX = useRef<number | null>(null);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (list.length < 2 || paused || reduced.current) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % list.length), AUTOPLAY_MS);
    return () => window.clearInterval(t);
  }, [list.length, paused, i]);

  if (!list.length) return null;

  const go = (n: number) => setI((n + list.length) % list.length);

  return (
    <section
      class="fixo-claro relative w-full overflow-hidden bg-ink text-bone"
      aria-roledescription="carrossel"
      aria-label="Ofertas em destaque"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX.current;
        if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
        touchX.current = null;
      }}
    >
      <div class="relative h-[72vh] min-h-[460px] w-full md:h-[86vh] md:max-h-[760px]">
        {list.map((s, idx) => {
          // Slide "arte pura": sem texto/eyebrow/subtítulo — a imagem já traz
          // tudo. Nesse caso não desenha o gradiente nem o bloco de texto, e o
          // slide inteiro vira link (se houver cta_href).
          const bare = !s.eyebrow && !s.title && !s.subtitle;
          const media = (
            <picture>
              {s.image_url_mobile && (
                // até 767px cobre celular; a condição de orientação estende
                // pro iPad em retrato (768–1024px), que senão cairia na
                // imagem desktop (bem mais larga) esticada num contêiner
                // alto — cortando o texto que fica colado na lateral.
                <source
                  media="(max-width: 767px), (max-width: 1024px) and (orientation: portrait)"
                  srcset={s.image_url_mobile}
                />
              )}
              <img
                src={imgSrc(s.image_url, 1920)}
                srcset={
                  /unsplash\.com\//.test(s.image_url)
                    ? `${imgSrc(s.image_url, 900)} 900w, ${imgSrc(s.image_url, 1400)} 1400w, ${imgSrc(s.image_url, 1920)} 1920w`
                    : undefined
                }
                sizes="100vw"
                alt={s.title || ''}
                class="h-full w-full object-cover"
                loading={idx === 0 ? 'eager' : 'lazy'}
                fetchPriority={idx === 0 ? 'high' : 'auto'}
                decoding="async"
              />
            </picture>
          );
          return (
            <div
              key={s.id}
              class={`absolute inset-0 transition-opacity duration-700 ease-smooth ${
                idx === i ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
              aria-hidden={idx !== i}
            >
              {s.image_url &&
                (bare && s.cta_href ? (
                  <a
                    href={s.cta_href}
                    class="block h-full w-full"
                    tabIndex={idx === i ? 0 : -1}
                    aria-label={s.cta_label || 'Ver oferta'}
                  >
                    {media}
                  </a>
                ) : (
                  media
                ))}

              {!bare && (
                <>
                  <div class="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/30 to-ink/10" />
                  <div class="absolute inset-0 flex items-end">
                    <div class="container-x pb-16 md:pb-24">
                      <div class="max-w-xl">
                        {s.eyebrow && (
                          <p class="font-sans text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-agua-light">
                            {s.eyebrow}
                          </p>
                        )}
                        <h2 class="mt-4 font-display text-[2.2rem] font-light leading-[1.08] text-bone sm:text-5xl md:text-6xl">
                          {s.title}
                        </h2>
                        {s.subtitle && (
                          <p class="mt-4 max-w-md font-sans text-[15px] leading-relaxed text-bone/75">
                            {s.subtitle}
                          </p>
                        )}
                        {s.cta_label && s.cta_href && (
                          <a
                            href={s.cta_href}
                            class="btn mt-7 bg-bone text-ink hover:bg-agua-light"
                            tabIndex={idx === i ? 0 : -1}
                          >
                            {s.cta_label}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {list.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(i - 1)}
              aria-label="Anterior"
              class="absolute left-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-ink/40 p-3 text-bone backdrop-blur transition-colors hover:bg-ink/70 md:block"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button
              type="button"
              onClick={() => go(i + 1)}
              aria-label="Próximo"
              class="absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-ink/40 p-3 text-bone backdrop-blur transition-colors hover:bg-ink/70 md:block"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <div class="absolute inset-x-0 bottom-6 flex justify-center gap-2">
              {list.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setI(idx)}
                  aria-label={`Ir para a oferta ${idx + 1}`}
                  aria-current={idx === i}
                  class={`h-1.5 rounded-full transition-all ${idx === i ? 'w-7 bg-bone' : 'w-1.5 bg-bone/40 hover:bg-bone/70'}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
