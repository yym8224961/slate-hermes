type Listener = () => void;

const sessionEndedListeners = new Set<Listener>();

export function notifySessionEnded(): void {
  [...sessionEndedListeners].forEach((listener) => listener());
}

export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => {
    sessionEndedListeners.delete(listener);
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sessionEndedListeners.clear();
  });
}
