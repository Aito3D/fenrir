import { useCallback, useMemo, useRef, useState } from 'react';
import { Archive, Check, Kanban, RotateCcw } from 'lucide-react';
import { CardView } from '../components/aito/CardView';
import { HoldButton } from '../components/aito/HoldButton';
import { ViewToggleButton } from '../components/aito/ViewToggleButton';
import { CelebrationProvider, useCelebration, type CelebrationVariant } from '../components/aito/celebration';
import { useReducedMotion } from '../hooks/useReducedMotion';
import type { AitoProject } from '../api/client';

/** Design bench for the Done celebration — DEV ONLY.
 *
 *  Registered behind `import.meta.env.DEV` in App.tsx, so it is dropped from
 *  the production bundle entirely. It exists to compare the propositions
 *  against each other in situ: real `CardView`, real `HoldButton` gesture,
 *  real board chrome and real theme accent, because a particle effect judged
 *  on a white mock page is judged on the wrong background at the wrong size.
 *
 *  English strings on purpose — nothing here ships, and putting demo copy
 *  through the i18n parity check would cost two locale files per label. */

interface Proposition {
  id: CelebrationVariant;
  name: string;
  blurb: string;
}

const PROPOSITIONS: Proposition[] = [
  {
    id: 'firework',
    name: 'Firework',
    blurb: 'Two shells launch from the card and burst overhead with a crackle. The most festive.',
  },
  {
    id: 'confetti',
    name: 'Confetti',
    blurb: 'A paper cannon: tumbling ribbons in the theme colour, gravity, and a muzzle flash.',
  },
  {
    id: 'bloom',
    name: 'Bloom',
    blurb: 'One shockwave and a ring of sparks, done in 600ms. Restrained enough for every day.',
  },
  {
    id: 'comet',
    name: 'Comet',
    blurb: 'The card’s spark arcs across the screen into the archive button and pops on arrival.',
  },
  {
    id: 'embers',
    name: 'Embers',
    blurb: 'Warm embers lift off the card and drift upward, flickering. Slow, physical, quiet.',
  },
];

const DEMO_CARDS: { id: number; description: string; client: string; company: boolean; shipping: boolean }[] = [
  { id: 9001, description: 'Support de caméra sur mesure', client: 'ACME SARL', company: true, shipping: false },
  { id: 9002, description: 'Boîtier étanche — série de 12', client: 'Tahiti Marine', company: true, shipping: true },
  { id: 9003, description: 'Réplique de pièce moteur', client: 'Manea Tehau', company: false, shipping: false },
];

function demoProject(card: (typeof DEMO_CARDS)[number]): AitoProject {
  return {
    id: card.id,
    description: card.description,
    column: 'finish',
    position: 0,
    status: 'active',
    client_id: `demo-${card.id}`,
    client_name: card.client,
    client_phone: '+689-87123456',
    client_email: null,
    client_is_company: card.company,
    client_social_network: null,
    client_social_handle: null,
    quote_id: null,
    quote_number: null,
    quote_date: null,
    quote_total: 48000,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'accepted',
    quote_accepted_at: null,
    quote_sync_state: 'idle',
    quote_invoiced: false,
    flag: null,
    client_contacted_at: null,
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: 2,
    tasks_total: 48000,
    task_services: ['print'],
    task_pending: [],
    steps_total: 4,
    steps_done: 4,
    task_steps: [],
    move_lock: null,
    shipping_island: card.shipping ? 'RAIATEA' : null,
    shipping_service: null,
    shipping_first_name: null,
    shipping_last_name: null,
    shipping_phone: null,
    shipping_price: null,
    shipping_service_name: null,
    version: 1,
    created_at: '2026-08-14T09:00:00',
    updated_at: '2026-08-19T09:00:00',
  } as AitoProject;
}

/** One card plus the gesture that finishes it. Owns the return-to-board timer
 *  so a proposition can be replayed as many times as it takes to choose. */
function DemoCard({ project }: { project: AitoProject }) {
  const celebrate = useCelebration();
  const ref = useRef<HTMLDivElement | null>(null);
  const [gone, setGone] = useState(false);
  const timer = useRef<number | null>(null);

  const finish = useCallback(() => {
    // Read before the card leaves: the burst starts where the card WAS, which
    // is the whole reason this is measured at the call site instead of being
    // approximated from the viewport.
    const rect = ref.current?.getBoundingClientRect();
    if (rect) celebrate(rect);
    setGone(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setGone(false), 2600);
  }, [celebrate]);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-300 ${
        gone ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      <CardView
        project={project}
        actions={
          <HoldButton
            onHold={finish}
            durationMs={500}
            label="Mark project done"
            hint="Hold to confirm"
            progress="perimeter"
            className="p-1 -m-1 text-bambu-green/70 hover:text-bambu-green hover:bg-bambu-green/10 focus-visible:ring-bambu-green/40 data-[holding=true]:text-bambu-green"
          >
            <Check className="relative w-3.5 h-3.5" />
          </HoldButton>
        }
      />
    </div>
  );
}

function Bench({ variant, onVariant }: { variant: CelebrationVariant; onVariant: (v: CelebrationVariant) => void }) {
  const celebrate = useCelebration();
  const reducedMotion = useReducedMotion();
  const projects = useMemo(() => DEMO_CARDS.map(demoProject), []);
  const columnRef = useRef<HTMLDivElement | null>(null);

  const fire = useCallback(() => {
    const rect = columnRef.current?.getBoundingClientRect();
    celebrate(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.45 } : { x: 400, y: 400 });
  }, [celebrate]);

  return (
    <div className="p-4 md:p-8 flex flex-col gap-6 min-h-[calc(100dvh-3.5rem)]">
      <div className="flex flex-col lg:flex-row lg:items-center gap-4">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3 flex-none">
          <Kanban className="w-7 h-7 text-bambu-green" />
          Done celebration
          <span className="px-2 py-0.5 text-sm font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full">
            5 propositions
          </span>
        </h1>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2 flex-none">
          {/* The comet's destination. Same attribute the real board's Show Done
              toggle carries, so the demo lands where production would. */}
          <ViewToggleButton active={false} onToggle={fire} icon={Archive} label="Show Done (128)" data-flight-target="" />
        </div>
      </div>

      <div className="flex flex-col xl:flex-row gap-6 items-start">
        {/* The propositions, as a list rather than a segmented control: each
            one needs a sentence, and a sentence does not fit in a tab. */}
        <div className="w-full xl:w-96 flex-none flex flex-col gap-2">
          {PROPOSITIONS.map((proposition, index) => {
            const active = proposition.id === variant;
            return (
              <button
                key={proposition.id}
                type="button"
                onClick={() => onVariant(proposition.id)}
                className={`text-left rounded-xl border px-4 py-3 transition-[background-color,border-color] duration-150 ${
                  active
                    ? 'border-bambu-green/60 bg-bambu-green/10'
                    : 'border-bambu-dark-tertiary bg-bambu-dark-secondary/40 hover:border-bambu-gray-dark'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`w-6 h-6 rounded-md grid place-items-center text-xs font-semibold tabular-nums ${
                      active ? 'bg-bambu-green text-black' : 'bg-bambu-dark-tertiary text-bambu-gray-light'
                    }`}
                  >
                    {index + 1}
                  </span>
                  <span className={`text-sm font-semibold ${active ? 'text-white' : 'text-bambu-gray-light'}`}>
                    {proposition.name}
                  </span>
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-bambu-gray">{proposition.blurb}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={fire}
            className="mt-2 flex items-center justify-center gap-2 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/40 px-4 py-3 text-sm font-medium text-bambu-gray-light hover:border-bambu-gray-dark"
          >
            <RotateCcw className="w-4 h-4" />
            Replay from the column
          </button>

          <p className="mt-1 text-xs leading-relaxed text-bambu-gray">
            Hold a card&apos;s check for half a second, exactly like the real board. The card returns after a moment so
            you can replay.
            {reducedMotion && ' — Reduced motion is ON, so nothing will fire.'}
          </p>
        </div>

        {/* The Finish column, chrome for chrome, so the effect is judged at the
            size and colour it will actually be seen at. */}
        <div
          ref={columnRef}
          className="w-72 sm:w-80 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border border-bambu-dark-tertiary"
        >
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60">
            <span className="w-2 h-2 rounded-full bg-bambu-green" />
            <h2 className="text-sm font-semibold text-white flex-1 truncate">Finition</h2>
            <span className="min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums">
              {projects.length}
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-2 p-2 min-h-[10rem]">
            {projects.map((project) => (
              <DemoCard key={project.id} project={project} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AitoFxDemoPage() {
  const [variant, setVariant] = useState<CelebrationVariant>('firework');

  return (
    <CelebrationProvider variant={variant}>
      <Bench variant={variant} onVariant={setVariant} />
    </CelebrationProvider>
  );
}
