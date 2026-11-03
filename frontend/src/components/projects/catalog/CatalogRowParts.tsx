import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Flame } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectCatalogItem } from '../../../api/client';
import { splitHighlight } from './catalogRules';

/** The pieces a project row is built from, shared by the desktop tree and the phone list. */

/** Text with the search terms marked. */
export function Highlight({ text, q }: { text: string; q: string }) {
  return (
    <>
      {splitHighlight(text, q).map((seg, i) =>
        seg.hit ? <mark key={i} className="rounded-sm bg-bambu-green/30 text-inherit">{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

/** The row's picture: the thumbnail fades in as it loads instead of popping (a lazily loaded
 *  one arrives while the list is on screen). A cached image is complete before React can
 *  listen for `load`, so the ref reads `complete` as well. */
export function Thumb({ item, className }: { item: ProjectCatalogItem; className: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark`}>
      {item.thumbnail_file_id !== null ? (
        <img
          src={api.getLibraryFileThumbnailUrl(item.thumbnail_file_id)}
          alt=""
          loading="lazy"
          ref={(el) => {
            if (el?.complete) setLoaded(true);
          }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
          className={`h-full w-full object-cover brightness-125 contrast-110 transition-opacity duration-200 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      ) : (
        <Box className="h-4 w-4 text-bambu-gray/40" aria-hidden />
      )}
    </div>
  );
}

/** The printed count: green once the target is met, a dash when never printed. */
export function PrintedCell({ item }: { item: ProjectCatalogItem }) {
  if (item.target_count) {
    const done = item.printed_count >= item.target_count;
    return <span className={done ? 'text-bambu-green' : 'text-white'}>{`${item.printed_count}/${item.target_count}`}</span>;
  }
  return item.printed_count > 0 ? <span className="text-white">{item.printed_count}</span> : <span className="text-bambu-gray/50">—</span>;
}

/** The project code, search terms marked; nothing when the project has none. */
export function CodeMark({ item, q }: { item: ProjectCatalogItem; q: string }) {
  return item.code && <span className="font-mono text-[11px] text-bambu-green"><Highlight text={item.code} q={q} /></span>;
}

/** The flame on a project with an open order. */
export function InProductionFlame({ item }: { item: ProjectCatalogItem }) {
  const { t } = useTranslation();
  return item.open_orders.length > 0 && <Flame className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-label={t('projectsPdm.catalog.inProduction')} />;
}
