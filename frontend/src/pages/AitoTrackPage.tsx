import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import aito3dLogo from '../assets/aito3d_logo.png';
import { TrackingInvoice } from '../components/aito/TrackingInvoice';
import { TrackingRail } from '../components/aito/TrackingRail';
import { FR, frLongDate, frUpdated, statusCopy } from '../utils/aitoTracking';
import { AITO3D_SENDER } from '../utils/shippingLabel';

const TEL = `tel:${AITO3D_SENDER.phone.replace(/[^\d+]/g, '')}`;
// 32 px between the four blocks on desktop, 26 px on phones.
const GAP = 'mt-[26px] sm:mt-8';

/** The client's public tracking page: standalone, no app chrome, fixed
 *  French, always dark (Midnight Blue + cyan) whatever the operator's
 *  theme. The current state is the hero; the brand is a small logo and a
 *  footer. Every error — 404, network — is the same "link no longer valid"
 *  line: a client never sees a status code or the login screen. */
export function AitoTrackPage() {
  const { token = '' } = useParams<{ token: string }>();
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
  const preOrder = data?.column === 'devis' || data?.column === 'waiting';
  return (
    <div className="min-h-screen bg-aito-midnight px-4 py-8 text-aito-ink sm:py-12">
      <div className="mx-auto max-w-[640px] rounded-2xl border border-aito-line bg-aito-card px-5 py-6 shadow-2xl sm:px-9 sm:py-8">
        <header className="text-center">
          {/* The asset is black + cyan; invert + hue-rotate turns the black
              white and brings the cyan back to cyan on the dark card. */}
          <img src={aito3dLogo} alt={FR.brand} className="mx-auto mb-7 h-8 w-auto" style={{ filter: 'invert(1) hue-rotate(180deg)' }} />
          <h1 className="text-[23px] font-semibold tracking-tight">{FR.title}</h1>
          {data?.reference && <p className="mt-1 text-[13.5px] text-aito-muted">{FR.reference(data.reference)}</p>}
        </header>
        <main>
          {query.isPending && <p className={`${GAP} text-aito-muted`}>{FR.loading}</p>}
          {query.isError && <p className={`${GAP} text-center text-lg`}>{FR.invalid}</p>}
          {data && copy && (
            <>
              <div className={GAP}>
                <TrackingRail column={data.column} shipped={data.shipping !== null} />
              </div>
              <section
                data-testid="track-state"
                className={`${GAP} rounded-xl border px-5 py-5 ${
                  preOrder ? 'border-aito-line bg-white/[.025]' : 'border-aito-cyan/35 bg-aito-cyan/10'
                }`}
              >
                <h2 className="text-xl font-semibold tracking-tight">{copy.title}</h2>
                <p className="mt-1 text-[15px] text-aito-muted">{copy.sub}</p>
                {data.due_date && (
                  <div className="mt-4 border-t border-aito-line/60 pt-3.5">
                    <p className="text-xs uppercase tracking-[.08em] text-aito-muted">{FR.eta}</p>
                    <p className="text-lg font-semibold text-aito-cyan">{frLongDate(data.due_date)}</p>
                  </div>
                )}
                <p className="mt-2.5 text-[12.5px] text-aito-muted">{FR.updated(frUpdated(data.updated_at))}</p>
              </section>
              <section className={GAP}>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[.08em] text-aito-muted">{FR.tasksHeading}</h3>
                <ul className="divide-y divide-aito-line/60 text-[15.5px]">
                  {data.tasks.map((task, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 py-[11px]">
                      <span className="min-w-0">{task.title}</span>
                      {task.quantity !== null && <span className="shrink-0 tabular-nums text-aito-muted">×{task.quantity}</span>}
                    </li>
                  ))}
                </ul>
              </section>
              {data.invoice && (
                <div className={GAP}>
                  <TrackingInvoice state={data.invoice} />
                </div>
              )}
            </>
          )}
        </main>
        <footer className={`${GAP} border-t border-aito-line/60 pt-5 text-center text-[13.5px] text-aito-muted`}>
          <p>
            {FR.footerLead}{' '}
            <a className="text-aito-ink" href={TEL}>{AITO3D_SENDER.phone}</a> {FR.footerOr}{' '}
            <a className="text-aito-ink" href={`mailto:${AITO3D_SENDER.email}`}>{AITO3D_SENDER.email}</a>.
          </p>
        </footer>
      </div>
    </div>
  );
}
