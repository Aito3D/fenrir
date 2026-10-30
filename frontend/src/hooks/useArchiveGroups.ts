import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { monthGroupKey, sortDateOf, type DoneSort } from '../utils/aitoDoneArchive';
import { parseUTCDateStrict } from '../utils/date';
import type { ArchiveGroup } from '../components/aito/archives/ArchiveGrid';
import type { AitoProject } from '../api/client';

/** The month-header function an archive grid groups under for a given sort,
 *  or null for a sort that is not a date. Shared by Done and Trash; each
 *  hands in its own clock for the finished/deleted dimension. The label is
 *  the operator's language's month name, capitalised: French spells months
 *  lowercase mid-sentence, but a header is not mid-sentence. */
export function useArchiveGroups(
  sort: DoneSort,
  dateOf: (project: AitoProject) => string | null,
): ((project: AitoProject) => ArchiveGroup) | null {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const stampOf = sortDateOf(sort, dateOf);
    if (!stampOf) return null;
    const format = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' });
    const undated = t('aito.doneArchive.undated');
    return (project: AitoProject) => {
      const stamp = stampOf(project);
      const key = monthGroupKey(stamp);
      if (key === null) return { key: 'undated', label: undated };
      const label = format.format(parseUTCDateStrict(stamp)!);
      return { key, label: label.charAt(0).toLocaleUpperCase(language) + label.slice(1) };
    };
  }, [sort, dateOf, language, t]);
}
