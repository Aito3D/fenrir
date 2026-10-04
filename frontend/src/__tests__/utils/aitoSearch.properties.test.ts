import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { matchesSearch, searchProjects } from '../../utils/aitoSearch';
import { fold } from '../../utils/aitoSearchNormalize';
import { makeProject } from '../fixtures/aitoProject';

describe('aitoSearch properties', () => {
  it('the board filter and the dropdown always agree', () => {
    const text = fc.string({ maxLength: 12 });
    fc.assert(
      fc.property(text, text, text, fc.string({ maxLength: 16 }), (description, client, phone, query) => {
        const p = makeProject({ description, client_name: client, client_phone: phone, search_text: '' });
        // A query that folds to nothing (spaces, a lone combining accent)
        // filters nothing and ranks nothing.
        const empty = fold(query).trim() === '';
        expect(matchesSearch(p, query)).toBe(empty || searchProjects([p], query).length > 0);
      }),
    );
  });
});
