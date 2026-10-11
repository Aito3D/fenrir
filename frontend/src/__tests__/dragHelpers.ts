/** True when a native `type` event fired by `fire` bubbles up to the document
 *  (i.e. no handler on the way stopped its propagation). */
export const reachesDocument = (type: 'dragover' | 'drop', fire: () => void) => {
  let reached = false;
  const listener = () => {
    reached = true;
  };
  document.addEventListener(type, listener);
  try {
    fire();
  } finally {
    document.removeEventListener(type, listener);
  }
  return reached;
};
