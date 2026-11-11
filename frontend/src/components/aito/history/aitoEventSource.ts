import { api } from '../../../api/client';
import type { EventSource } from './ActivityRail';
import { eventLabelKey, labelParams } from './eventKinds';

/** An Aito project's timeline as an `ActivityRail` source. */
export function aitoEventSource(projectId: number): EventSource {
  return {
    key: ['aito-events', projectId],
    fetchPage: (depth, cursor) => api.getAitoEvents(projectId, { depth, cursor, limit: 50 }),
    addNote: (body) => api.addAitoNote(projectId, body),
    label: (event) => {
      const key = eventLabelKey(event);
      return key ? { key, params: labelParams(event) ?? undefined } : null;
    },
    depthKey: 'aito.history.depth',
  };
}
