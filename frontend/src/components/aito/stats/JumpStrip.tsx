import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface JumpSection {
  id: string;
  label: string;
}

/** How long a click owns the highlight while the smooth scroll passes the
 *  sections in between. */
const CLICK_LOCK_MS = 900;

/** The nearest ancestor that actually scrolls — the app's main pane, not
 *  the window — or null for the window itself. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** The sticky pill row under the timeframe selector: one pill per section,
 *  the section under the strip highlighted, a click scrolls the section to
 *  the top (smooth unless the OS asks for reduced motion). Sections carry
 *  `scroll-mt-14` so the strip never covers their heading.
 *
 *  Scroll-spy by position, not IntersectionObserver: the observer only
 *  reports entries that CHANGED, so a callback fired by the next section
 *  entering would steal the highlight from the one still under the strip.
 *  The rule is "the last section whose top has passed the strip", with the
 *  last pill winning once the pane is scrolled to its end — otherwise a
 *  short final section could never be highlighted. */
export function JumpStrip({ sections }: { sections: JumpSection[] }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [active, setActive] = useState(sections[0]?.id);
  const navRef = useRef<HTMLElement>(null);
  const lockUntil = useRef(0);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const pane = scrollParentOf(nav);
    const target: HTMLElement | Window = pane ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (performance.now() < lockUntil.current) return;
      const stripBottom = nav.getBoundingClientRect().bottom + 8;
      const atEnd = pane
        ? pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
        : window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      let current = sections[0]?.id;
      if (atEnd) {
        current = sections[sections.length - 1]?.id;
      } else {
        for (const s of sections) {
          const el = document.getElementById(s.id);
          if (el && el.getBoundingClientRect().top <= stripBottom) current = s.id;
        }
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sections]);

  const jump = (id: string) => {
    lockUntil.current = performance.now() + (reduced ? 0 : CLICK_LOCK_MS);
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <nav
      ref={navRef}
      aria-label={t('aito.stats.sections')}
      className="sticky top-0 z-10 -mx-1 overflow-x-auto bg-bambu-dark px-1 py-2"
    >
      <ul className="flex gap-2">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => jump(s.id)}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active === s.id
                  ? 'bg-bambu-green text-white'
                  : 'bg-bambu-dark-secondary text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
              }`}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
