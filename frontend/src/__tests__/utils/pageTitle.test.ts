import { describe, it, expect } from 'vitest';
import { pageTitleKey } from '../../utils/pageTitle';

const nav = [
  { to: '/', labelKey: 'nav.printers' },
  { to: '/queue', labelKey: 'nav.queue' },
  { to: '/projects', labelKey: 'nav.projects' },
  { to: '/files', labelKey: 'nav.files' },
];

describe('pageTitleKey', () => {
  it('matches the root exactly and nothing else against it', () => {
    expect(pageTitleKey('/', nav)).toBe('nav.printers');
    expect(pageTitleKey('/nowhere', nav)).toBeNull();
  });

  it('matches a nav item and its sub-routes on a path boundary', () => {
    expect(pageTitleKey('/queue', nav)).toBe('nav.queue');
    expect(pageTitleKey('/queue/', nav)).toBe('nav.queue');
    expect(pageTitleKey('/projects/12', nav)).toBe('nav.projects');
    expect(pageTitleKey('/projectsx', nav)).toBeNull();
  });

  it('prefers the extras table over a nav prefix', () => {
    expect(pageTitleKey('/files/trash', nav)).toBe('libraryTrash.title');
    expect(pageTitleKey('/system', nav)).toBe('system.title');
    expect(pageTitleKey('/printer-locations', nav)).toBe('printers.locations.title');
    expect(pageTitleKey('/groups/new', nav)).toBe('groups.editor.createTitle');
    expect(pageTitleKey('/groups/7/edit', nav)).toBe('groups.editor.title');
  });

  it('shows nothing for pages without a title of their own', () => {
    expect(pageTitleKey('/gcode-viewer', nav)).toBeNull();
    expect(pageTitleKey('/external/3', nav)).toBeNull();
  });
});
