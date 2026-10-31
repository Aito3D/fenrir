/// <reference lib="webworker" />
// G-code toolpath parsing in a worker (part viewer, 2026-10-31): a large sliced file takes
// seconds to parse, which froze the UI and left the loading bar still. Here the parse runs off
// the main thread and reports its progress; the layers' path buffers are transferred back.
import { parseGcodeToolpath } from '../lib/gcodeToolpath';
import type { ParsedToolpath } from '../lib/gcodeToolpath';

export interface GcodeWorkerRequest {
  id: number;
  text: string;
}

export type GcodeWorkerResponse =
  | { id: number; type: 'progress'; share: number }
  | { id: number; type: 'done'; parsed: ParsedToolpath }
  | { id: number; type: 'error'; reason: string };

self.onmessage = (event: MessageEvent<GcodeWorkerRequest>) => {
  const { id, text } = event.data;
  try {
    const parsed = parseGcodeToolpath(text, (share) => {
      const message: GcodeWorkerResponse = { id, type: 'progress', share };
      self.postMessage(message);
    });
    const message: GcodeWorkerResponse = { id, type: 'done', parsed };
    self.postMessage(message, parsed.layers.map((l) => l.paths.buffer as ArrayBuffer));
  } catch (err) {
    const message: GcodeWorkerResponse = { id, type: 'error', reason: err instanceof Error ? err.message : 'parse' };
    self.postMessage(message);
  }
};
