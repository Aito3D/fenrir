import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import { api, type InboxKindInfo, type InboxPreferences as Prefs, type InboxPreferencesUpdate } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Card, CardContent } from '../Card';
import { Toggle } from '../Toggle';
import { NOTIFICATION_KINDS, UNKNOWN_KIND } from '../notificationKinds';

/** Shared with the bell's sound toggle, so both always show the same state. */
const PREFS_KEY = ['inbox-preferences'];
const SAVE_DELAY_MS = 400;
const FAMILIES = [
  { family: 'aito', labelKey: 'inbox.familyAito' },
  { family: 'printer', labelKey: 'inbox.familyPrinters' },
];

const without = (list: string[], drop: string[]) => list.filter((k) => !drop.includes(k));
const withAll = (list: string[], add: string[]) => [...list, ...add.filter((k) => !list.includes(k))];

/** Settings → Notifications → Inbox. Per user, so only rendered for a signed-in user. */
export function InboxPreferences() {
  const { authEnabled, user } = useAuth();
  if (!authEnabled || !user) return null;
  return <InboxPreferencesBlock />;
}

function InboxPreferencesBlock() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: prefs } = useQuery({ queryKey: PREFS_KEY, queryFn: api.getInboxPreferences });

  // One PUT per burst: each change replaces the pending body and restarts the timer.
  const pending = useRef<InboxPreferencesUpdate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edits = useRef(0);
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    flushRef.current = () => {
      timer.current = null;
      const body = pending.current;
      if (!body) return;
      pending.current = null;
      const edit = edits.current;
      api
        .putInboxPreferences(body)
        // A later edit already owns the cache; the server echo would roll it back.
        .then((saved) => edits.current === edit && queryClient.setQueryData(PREFS_KEY, saved))
        .catch(() => {
          showToast(t('inbox.saveFailed'), 'error');
          queryClient.invalidateQueries({ queryKey: PREFS_KEY });
        });
    };
  });

  // Leaving the tab mid-burst still saves the last change.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      flushRef.current();
    },
    [],
  );

  const save = (change: (p: InboxPreferencesUpdate) => InboxPreferencesUpdate) => {
    // Read the cache, not the render's `prefs`: two clicks before a re-render must compose.
    const current = queryClient.getQueryData<Prefs>(PREFS_KEY);
    if (!current) return;
    const next = change(current);
    queryClient.setQueryData<Prefs>(PREFS_KEY, { ...current, ...next });
    pending.current = { kinds: next.kinds, sound_kinds: next.sound_kinds, auto_watch: next.auto_watch };
    edits.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY_MS);
  };

  const setKind = (kind: string, on: boolean) =>
    save((p) => ({
      ...p,
      kinds: on ? withAll(p.kinds, [kind]) : without(p.kinds, [kind]),
      sound_kinds: on ? p.sound_kinds : without(p.sound_kinds, [kind]),
    }));

  const setRing = (kind: string, on: boolean) =>
    save((p) => ({ ...p, sound_kinds: on ? withAll(p.sound_kinds, [kind]) : without(p.sound_kinds, [kind]) }));

  // Off drops every kind of the family; on restores its defaults, ringing like a new user's.
  const setFamily = (kinds: InboxKindInfo[], on: boolean) => {
    const all = kinds.map((k) => k.kind);
    const defaults = kinds.filter((k) => k.default_on && k.available).map((k) => k.kind);
    save((p) => ({
      ...p,
      kinds: on ? withAll(p.kinds, defaults) : without(p.kinds, all),
      sound_kinds: on ? withAll(p.sound_kinds, defaults) : without(p.sound_kinds, all),
    }));
  };

  const kindTitle = (kind: string) => {
    const meta = NOTIFICATION_KINDS[kind];
    return meta ? t(`inbox.kind.${meta.titleKey}`) : kind;
  };

  return (
    <section className="mt-6" aria-labelledby="card-inbox">
      <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-2" id="card-inbox">
        <Inbox className="w-5 h-5 text-bambu-green" />
        {t('inbox.settingsTitle')}
      </h2>
      <p className="text-sm text-bambu-gray">{t('inbox.settingsIntro')}</p>
      <p className="text-xs text-bambu-gray mb-3">{t('inbox.perUser')}</p>
      {prefs && (
        <Card>
          <CardContent className="py-3 space-y-4">
            {FAMILIES.map(({ family, labelKey }) => {
              const kinds = prefs.available.filter((k) => k.family === family);
              if (kinds.length === 0) return null;
              const familyOn = kinds.some((k) => k.available && prefs.kinds.includes(k.kind));
              const label = t(labelKey);
              return (
                <div key={family}>
                  <div className="flex items-center justify-between gap-3 pb-2 border-b border-bambu-dark-tertiary">
                    <p className="text-white text-sm font-medium">{label}</p>
                    <div className="flex items-center gap-3">
                      <span className="w-11 md:w-9 text-center text-xs text-bambu-gray">{t('inbox.ring')}</span>
                      <Toggle
                        checked={familyOn}
                        disabled={!kinds.some((k) => k.available)}
                        onChange={(on) => setFamily(kinds, on)}
                        aria-label={label}
                      />
                    </div>
                  </div>
                  <ul className="mt-1">
                    {kinds.map((info) => {
                      const on = info.available && prefs.kinds.includes(info.kind);
                      const ring = on && prefs.sound_kinds.includes(info.kind);
                      const meta = NOTIFICATION_KINDS[info.kind] ?? UNKNOWN_KIND;
                      const Icon = meta.icon;
                      const title = kindTitle(info.kind);
                      return (
                        <li key={info.kind} className="flex items-center justify-between gap-3 py-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`p-1 rounded-md ${meta.tone}`}>
                              <Icon className="w-3.5 h-3.5" />
                            </span>
                            <span className={`text-sm truncate ${info.available ? 'text-white' : 'text-bambu-gray'}`}>
                              {title}
                            </span>
                            {!info.available && (
                              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-bambu-dark-tertiary text-bambu-gray">
                                {t('inbox.comingLater')}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Toggle
                              checked={ring}
                              disabled={!on}
                              onChange={(v) => setRing(info.kind, v)}
                              aria-label={`${t('inbox.ring')}: ${title}`}
                            />
                            <Toggle
                              checked={on}
                              disabled={!info.available}
                              onChange={(v) => setKind(info.kind, v)}
                              aria-label={title}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-bambu-dark-tertiary">
              <p className="text-white text-sm font-medium">{t('inbox.autoWatch')}</p>
              <Toggle
                checked={prefs.auto_watch}
                onChange={(v) => save((p) => ({ ...p, auto_watch: v }))}
                aria-label={t('inbox.autoWatch')}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
