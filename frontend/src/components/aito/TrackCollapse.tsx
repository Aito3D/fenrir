/** A disclosure body on the public tracking page that opens AND closes the
 *  same way — a grid row growing from 0fr to 1fr with a fade — instead of
 *  rising in and snapping shut, which yanked the footer up. The content stays
 *  mounted: `inert` + `aria-hidden` take it out of the tab order and the
 *  accessibility tree while closed, so a screen reader meets exactly what a
 *  sighted user sees. Shapes and timings live in index.css (`.track-collapse`);
 *  children that want to rise on open add `animate-rise` only while `open`,
 *  because adding the class is what starts the animation. */
export function TrackCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className="track-collapse" data-open={open || undefined} aria-hidden={!open} inert={!open} data-testid="track-collapse">
      <div className="track-collapse-inner">{children}</div>
    </div>
  );
}
