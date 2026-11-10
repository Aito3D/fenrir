import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import type { FollowupKey } from '../../utils/aitoFollowups';
import type { AitoView } from '../../hooks/useAitoViewParams';
import { useDeepLinkParam } from '../../hooks/useDeepLinkParam';

// The `?card=` / `?newFromProject=` deep links of the board page, lifted out
// of AitoPage. Each hook holds the effect that used to sit inline, and the
// page calls it at the same position, so effect order is unchanged.

/** Mirrors `expandedId` into `?card=` both ways round (see the page). */
export function useCardUrlMirror(expandedId: number | null) {
  const [searchParams, setSearchParams] = useSearchParams();
  // The last `expandedId` the mirror saw, so a close (non-null → null) can be
  // told from a link that is still being resolved (null all along).
  const mirroredId = useRef<number | null>(null);
  useEffect(() => {
    const closed = expandedId === null && mirroredId.current !== null;
    mirroredId.current = expandedId;
    const wanted = expandedId === null ? null : String(expandedId);
    if (searchParams.get('card') === wanted) return;
    // Null with nothing closed: a pending link, whose parameter the resolver
    // below still needs. Everything else is a mismatch the URL must follow.
    if (wanted === null && !closed) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (wanted === null) next.delete('card');
        else next.set('card', wanted);
        return next;
      },
      // Replace, not push: Back leaves the board, it does not step back
      // through every card that was peeked at.
      { replace: true },
    );
  }, [expandedId, searchParams, setSearchParams]);
}

interface CardResolverArgs {
  cardParam: string | null;
  clearCardParam: () => void;
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  setFollowup: (key: FollowupKey | null) => void;
  setView: (view: AitoView) => void;
  aitoQuery: UseQueryResult<AitoProject[]>;
  trashQuery: UseQueryResult<AitoProject[]>;
}

/** Acts once on a `?card=` link; see the comments inside. */
export function useCardResolver({
  cardParam,
  clearCardParam,
  expandedId,
  setExpandedId,
  setFollowup,
  setView,
  aitoQuery,
  trashQuery,
}: CardResolverArgs) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  // A link is the parameter on one history entry, not the parameter's text:
  // the router renders a navigation in a transition, so a second link to the
  // same card can land before the clear of the first one ever rendered.
  const { key: locationKey } = useLocation();
  const link = cardParam === null ? null : `${locationKey}|${cardParam}`;
  // The link the resolver has already acted on. The mirror writes
  // the same parameter for a card opened from the board, and a board refetch
  // re-runs the resolver with it still there; neither may reopen or
  // re-scroll. Reset when the parameter leaves, so the same link works twice.
  const cardResolved = useRef<string | null>(null);
  // The link the board was refetched for. A miss is never decided from the
  // cached lists alone: an inbox link usually names a card someone else made a
  // moment ago, which a board cache up to a minute old does not hold yet. So
  // the first miss refetches both lists once, and the answer comes from that.
  const cardRefetchedFor = useRef<string | null>(null);
  // That refetch's own answer. The query flags reach this hook a tick after
  // refetch(), so a render in between still sees the old lists; the miss is
  // decided from this, keyed by a token so an earlier link's answer never counts.
  const refetchToken = useRef<object | null>(null);
  const [refetched, setRefetched] = useState<{
    token: object;
    board: AitoProject[] | undefined;
    trash: AitoProject[] | undefined;
    failed: boolean;
  } | null>(null);
  const refetchBoard = aitoQuery.refetch;
  const refetchTrash = trashQuery.refetch;
  // The plain `setExpandedId`, not `openCard`: the morph needs a source card
  // on screen, and a link arrives with nothing clicked.
  useEffect(() => {
    if (cardParam === null || link === null) {
      cardResolved.current = null;
      cardRefetchedFor.current = null;
      return;
    }
    if (cardResolved.current === link) return;
    // A panel already up wrote this parameter itself (the mirror above): the
    // link is not a request, it is a reflection.
    if (expandedId !== null) {
      cardResolved.current = link;
      return;
    }
    if (!aitoQuery.data) return;
    const id = Number(cardParam);
    const card = aitoQuery.data.find((p) => p.id === id);
    if (card) {
      cardResolved.current = link;
      setExpandedId(id);
      // A done card has no column on the board: bring the archive up behind
      // the panel instead, so the card is on screen when the panel closes.
      // Plain, not `changeView`: nothing is on screen yet to transition
      // from. The follow-up filter goes the way it does on any view change.
      if (card.column === 'done') {
        setFollowup(null);
        setView('done');
      } else document.querySelector(`[data-column-id="${card.column}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
    if (aitoQuery.isFetching || trashQuery.isFetching || trashQuery.isPending) return;
    if (cardRefetchedFor.current !== link) {
      cardRefetchedFor.current = link;
      const token = {};
      refetchToken.current = token;
      void Promise.all([refetchBoard(), refetchTrash()]).then(([board, trash]) =>
        setRefetched({ token, board: board.data, trash: trash.data, failed: board.isError || trash.isError }),
      );
      return;
    }
    if (!refetched || refetched.token !== refetchToken.current) return;
    // The fresh board holds it: the branch above opens it once that data renders.
    if (refetched.board?.some((p) => p.id === id)) return;
    clearCardParam();
    // A list that could not be read cannot say the card is gone.
    if (refetched.failed) {
      showToast(t('aito.cardLookupFailed'), 'error');
      return;
    }
    const inTrash = refetched.trash?.some((p) => p.id === id) ?? false;
    showToast(t(inTrash ? 'aito.cardInTrash' : 'aito.cardGone'), inTrash ? 'info' : 'error');
  }, [
    cardParam,
    link,
    expandedId,
    aitoQuery.data,
    aitoQuery.isFetching,
    trashQuery.isFetching,
    trashQuery.isPending,
    refetched,
    refetchBoard,
    refetchTrash,
    clearCardParam,
    setExpandedId,
    setFollowup,
    setView,
    showToast,
    t,
  ]);
}

/** `?newFromProject=` seeding of the create drawer; see the comments inside. */
export function useNewFromProject({
  canCreate,
  setShowModal,
}: {
  canCreate: boolean;
  setShowModal: Dispatch<SetStateAction<boolean>>;
}) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  // `?newFromProject=7` (a PDM project page's "New order"): the create drawer
  // opens seeded from that project, and the order it creates gets its first
  // task linked to it (by the create mutation itself — see
  // useAitoPageMutations). The parameter leaves the URL once the drawer is
  // submitted or closed, so a reload never reopens it.
  const [newFromProjectParam, clearNewFromProjectParam] = useDeepLinkParam('newFromProject');
  const [projectSeed, setProjectSeed] = useState<{
    projectId: number;
    seed: { description: string; taskTitle: string };
  } | null>(null);
  const seedRequestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (newFromProjectParam === null) {
      seedRequestedFor.current = null;
      return;
    }
    if (seedRequestedFor.current === newFromProjectParam) return;
    seedRequestedFor.current = newFromProjectParam;
    const projectId = Number(newFromProjectParam);
    if (!canCreate || !Number.isInteger(projectId) || projectId <= 0) {
      clearNewFromProjectParam();
      return;
    }
    api.getProject(projectId).then(
      (project) => {
        setProjectSeed({
          projectId,
          seed: { description: project.description?.trim() || project.name, taskTitle: project.name },
        });
        setShowModal(true);
      },
      () => {
        clearNewFromProjectParam();
        showToast(t('common.errorLoading'), 'error');
      },
    );
  }, [newFromProjectParam, canCreate, clearNewFromProjectParam, setShowModal, showToast, t]);

  /** Drops the seed and its URL parameter; a no-op when nothing was seeded. */
  const resetProjectSeed = () => {
    if (projectSeed) {
      setProjectSeed(null);
      clearNewFromProjectParam();
    }
  };

  return { projectSeed, resetProjectSeed };
}
