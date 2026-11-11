// Containment for store listeners.
//
// A zustand store notifies its listeners in a plain loop. If one of them throws, the listeners after it
// are never called for that change — and React's own subscriptions are in that list — so a single bad
// listener (say, the cache validator meeting a document it cannot read) leaves the whole UI showing
// stale state. Every listener registered through `subscribe` is therefore wrapped: a failure is reported
// and the remaining listeners still run. React components are unaffected (they subscribe through the
// store's internal API and report their own errors to the nearest error boundary).

type Listener = (...args: never[]) => void;

export function guardListeners(store: { subscribe: (listener: never) => () => void }, label: string): void {
  const subscribe = store.subscribe as unknown as (listener: Listener) => () => void;
  (store as { subscribe: unknown }).subscribe = (listener: Listener) =>
    subscribe(((...args: never[]) => {
      try {
        listener(...args);
      } catch (e) {
        console.error(`[${label}] a store listener failed`, e);
      }
    }) as Listener);
}
