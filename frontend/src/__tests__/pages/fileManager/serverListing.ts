import type { LibraryFileListItem } from '../../../api/client';

/**
 * What GET /library/files answers for `files`, for tests written against a
 * browser that filtered and sorted the whole listing itself (upstream #3628).
 * Fenrir's File Manager asks the server to search, filter and sort, so a mock
 * that returns every row regardless of the query hides nothing.
 *
 * Mirrors routes/library.py: the folder's own rows are filtered and sorted,
 * then `with_variant_members` adds the other visible members of the groups in
 * the result, flagged `variant_elsewhere`.
 */
export function serverListing(files: LibraryFileListItem[], url: URL): LibraryFileListItem[] {
  const params = url.searchParams;
  const search = (params.get('search') ?? '').trim().toLowerCase();
  const fileType = params.get('file_type');
  const name = (f: LibraryFileListItem) => f.print_name || f.filename;

  let own = files.filter((f) => !f.variant_elsewhere);
  if (search) {
    own = own.filter(
      (f) => f.filename.toLowerCase().includes(search) || (f.print_name ?? '').toLowerCase().includes(search),
    );
  }
  if (fileType) own = own.filter((f) => f.file_type === fileType);
  if (params.get('sort') === 'name') {
    own.sort((a, b) => name(a).toLowerCase().localeCompare(name(b).toLowerCase()) || a.id - b.id);
    if (params.get('direction') === 'desc') own.reverse();
  }
  if (params.get('with_variant_members') !== 'true') return own;

  const shown = new Set(own.map((f) => f.id));
  const groups = new Set(own.map((f) => f.variant_group_id).filter((id) => id != null));
  const extras = files
    .filter((f) => f.variant_group_id != null && groups.has(f.variant_group_id) && !shown.has(f.id))
    .map((f) => ({ ...f, variant_elsewhere: true }));
  return [...own, ...extras];
}
