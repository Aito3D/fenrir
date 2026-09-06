import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import aito3dLogo from '../assets/aito3d_logo.png';
import { TrackingInvoice } from '../components/aito/TrackingInvoice';
import { TrackingRail } from '../components/aito/TrackingRail';
import { FR, etaCopy, frUpdated, statusCopy } from '../utils/aitoTracking';
import { AITO3D_SENDER } from '../utils/shippingLabel';

const TEL = `tel:${AITO3D_SENDER.phone.replace(/[^\d+]/g, '')}`;

// Above this many parts, fold to the first six behind a "Voir les n pièces"
// button — a 60-character name and a 10+ item list must still hold (§7b).
const PARTS_FOLD = 8;
const PARTS_SHOWN = 6;

// The card: fluid below 620 px (`calc(100% - 32px)` on phones), capped at
// 620 px and centred from `sm:` up — the finishing pass's own numbers
// (§7b "Composition and spacing" + "Final pixel pass"), not a redesign.
const CARD =
  'mx-auto w-[calc(100%-32px)] max-w-[620px] rounded-[12px] border border-aito-line bg-aito-card px-[24px] py-[24px] sm:w-auto sm:px-[32px] sm:py-[32px]';
const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan';

/** The asset is black + cyan; invert + hue-rotate turns the black white and
 *  brings the cyan back to cyan on the dark card. 26 px tall (§7b final
 *  pixel pass) — pixel-exact because this repo's 14.4 px root shorts
 *  Tailwind's rem-based height utilities. */
function Logo({ className = '' }: { className?: string }) {
  return (
    <img
      src={aito3dLogo}
      alt={FR.brand}
      className={`mx-auto h-[26px] w-auto ${className}`}
      style={{ filter: 'invert(1) hue-rotate(180deg)' }}
    />
  );
}

function Footer() {
  const linkCls = `inline-flex min-h-[44px] items-center text-aito-muted transition-colors duration-150 hover:text-aito-ink ${FOCUS} focus-visible:text-aito-ink`;
  return (
    <footer className="mt-[32px] border-t border-aito-line/60 pt-[24px] text-center text-[13.5px]">
      <p className="text-aito-ink">{FR.footerQuestion}</p>
      <p className="mt-[8px]">
        <a className={linkCls} href={TEL}>
          {AITO3D_SENDER.phone}
        </a>
        {/* The dot only makes sense while both links share a line; below
            360 px the email wraps, and a dangling dot would trail the phone. */}
        <span className="mx-[4px] max-[359px]:hidden" aria-hidden="true">
          ·
        </span>
        <a className={linkCls} href={`mailto:${AITO3D_SENDER.email}`}>
          {AITO3D_SENDER.email}
        </a>
      </p>
    </footer>
  );
}

/** The client's public tracking page: standalone, no app chrome, fixed
 *  French, always dark (Midnight Blue + cyan) whatever the operator's
 *  theme. The current state is the hero; the brand is a small logo and a
 *  footer. A 404 (expired or unknown link, §2) gets its own dedicated
 *  page — never a stack trace, a raw API message or the login screen; any
 *  other failure offers a "Réessayer" button instead. */
export function AitoTrackPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [showAllParts, setShowAllParts] = useState(false);
  const query = useQuery({
    queryKey: ['aito-track', token],
    queryFn: () => api.getAitoTracking(token),
    enabled: token !== '',
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    document.title = 'Suivi de commande · Aito 3D';
  }, []);

  const data = query.data;
  const copy = data ? statusCopy(data) : null;
  const eta = data ? etaCopy(data) : null;
  const preOrder = data?.column === 'devis' || data?.column === 'waiting';
  const is404 = query.error instanceof ApiError && query.error.status === 404;

  if (is404) {
    return (
      <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
        <div className={CARD}>
          <header className="text-center">
            <Logo className="mb-[20px]" />
            <h1 className="text-[23px] font-semibold tracking-tight">{FR.invalidTitle}</h1>
            <p className="mt-[8px] text-[15px] text-aito-muted">{FR.invalidBody}</p>
          </header>
          <Footer />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
      <div className={CARD}>
        <header className="text-center">
          <Logo className="mb-[20px]" />
          <h1 className="text-[23px] font-semibold tracking-tight">{FR.title}</h1>
          {data?.reference && <p className="mt-[8px] text-[13.5px] text-aito-muted">{FR.reference(data.reference)}</p>}
        </header>
        <main>
          {query.isPending && (
            <div className="mt-[32px] space-y-[32px]" aria-hidden="true">
              <div className="h-[64px] rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse" />
              <div className="rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse sm:min-h-[132px]" />
            </div>
          )}
          {query.isError && !is404 && (
            <div className="mt-[32px] text-center">
              <p className="text-[15px] text-aito-muted">{FR.error}</p>
              <button
                type="button"
                onClick={() => query.refetch()}
                className={`mt-[16px] inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan transition-colors duration-150 hover:bg-aito-cyan/10 ${FOCUS}`}
              >
                {FR.retry}
              </button>
            </div>
          )}
          {data && copy && (
            <>
              <div className="mt-[32px]">
                <TrackingRail column={data.column} shipped={data.shipping !== null} />
              </div>
              <section
                data-testid="track-state"
                className={`mt-[32px] rounded-[12px] border px-[16px] py-[16px] transition-colors duration-150 sm:min-h-[132px] sm:px-[24px] sm:py-[16px] ${
                  preOrder ? 'border-aito-line bg-white/[.025]' : 'border-aito-cyan/35 bg-aito-cyan/10'
                }`}
              >
                <h2 className="text-[19px] font-semibold tracking-tight">{copy.title}</h2>
                <p className="mt-[8px] text-[15px] text-aito-muted">{copy.sub}</p>
                {eta && eta.kind !== 'none' && (
                  <div className="mt-[12px] border-t border-aito-line/60 pt-[12px]">
                    <p className="text-[12px] uppercase tracking-[.08em] text-aito-muted">{FR.eta}</p>
                    <p className={eta.kind === 'date' ? 'mt-[4px] text-[17px] font-semibold text-aito-cyan' : 'mt-[4px] text-[15px] text-aito-ink'}>
                      {eta.text}
                    </p>
                  </div>
                )}
                <p className="mt-[8px] text-[13px] text-aito-muted/80">{FR.updated(frUpdated(data.updated_at))}</p>
              </section>
              <section className="mt-[24px]">
                <h3 className="mb-[16px] text-[12px] font-semibold uppercase tracking-[.08em] text-aito-muted">{FR.tasksHeading}</h3>
                {(() => {
                  const folded = data.tasks.length > PARTS_FOLD && !showAllParts;
                  const shown = folded ? data.tasks.slice(0, PARTS_SHOWN) : data.tasks;
                  return (
                    <>
                      <ul className="divide-y divide-aito-line/60 text-[15px]">
                        {shown.map((task, i) => (
                          <li key={i} className="flex items-start justify-between gap-[12px] py-[12px]">
                            <span className="min-w-0">{task.title}</span>
                            {task.quantity !== null && (
                              <span className="min-w-[28px] shrink-0 text-right tabular-nums text-aito-muted">×{task.quantity}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {folded && (
                        <button
                          type="button"
                          onClick={() => setShowAllParts(true)}
                          className={`mt-[12px] inline-flex min-h-[44px] items-center rounded-[8px] text-[13.5px] font-semibold text-aito-cyan transition-colors duration-150 hover:text-aito-cyan/80 ${FOCUS}`}
                        >
                          {FR.showAllParts(data.tasks.length)}
                        </button>
                      )}
                    </>
                  );
                })()}
              </section>
              {data.invoice && (
                <div className="mt-[32px]">
                  <TrackingInvoice state={data.invoice} />
                </div>
              )}
            </>
          )}
        </main>
        <Footer />
      </div>
    </div>
  );
}
