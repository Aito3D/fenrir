import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface JumpSection {
  id: string;
  label: string;
}

/** The sticky pill row under the timeframe selector: one pill per section,
 *  the one under the strip highlighted, a click scrolls the section to the
 *  top (smooth unless the OS asks for reduced motion). Sections carry
 *  `scroll-mt-14` so the strip never covers their heading. */
export function JumpStrip({ sections }: { sections: JumpSection[] }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    // jsdom has no IntersectionObserver; the strip still works by click.
    if (typeof IntersectionObserver === 'undefined') return;
    const targets = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-56px 0px -55% 0px', threshold: 0 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    setActive(id);
  };

  return (
    <nav aria-label={t('aito.stats.sections')} className="sticky top-0 z-10 -mx-1 overflow-x-auto bg-bambu-dark px-1 py-2">
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
