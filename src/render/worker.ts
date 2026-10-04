// Render worker entry point. All GPU work (WebGL2 on OffscreenCanvas), media decoding and export
// encoding happen here so the UI thread stays responsive.

import { RenderServer } from './server';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as {
  postMessage(m: FromWorker, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const server = new RenderServer((m, transfer) => scope.postMessage(m, transfer ?? []));

scope.onmessage = (e) => {
  void server.handle(e.data);
};
