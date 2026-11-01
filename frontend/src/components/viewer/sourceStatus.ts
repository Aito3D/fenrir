/** Which of the viewer's two sources a loading status belongs to. */
export type ViewerSource = 'model' | 'toolpath';

/**
 * The loading overlay shows the status of the tab on screen, and only that one.
 *
 * The model and the toolpath load independently, often at the same time, and
 * each used to write straight to the one status the modal displays. Opening on
 * the Model tab and switching to Toolpath while its file was still parsing left
 * "Preparing the part…" up for good: the toolpath loader's final "done" was
 * gated on the tab it had captured when it started. Here every report is filed
 * under its source; it reaches the overlay only while that source's tab is
 * showing, and switching tabs replays the status of the tab arrived at.
 */
export function createSourceStatus<S>(idle: S, emit: (status: S) => void, tab: () => ViewerSource) {
  const book: Record<ViewerSource, S> = { model: idle, toolpath: idle };
  return {
    /** File a status under its source; shown at once if that tab is on screen. */
    set(source: ViewerSource, status: S): void {
      book[source] = status;
      if (tab() === source) emit(status);
    },
    /** The tab changed: show what its source last reported. */
    show(source: ViewerSource): void {
      emit(book[source]);
    },
    /** For tests and the webgl path: the last status filed for a source. */
    get(source: ViewerSource): S {
      return book[source];
    },
  };
}
