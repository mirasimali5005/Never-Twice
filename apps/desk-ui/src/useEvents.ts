// One event stream per run (SSE /api/runs/:run_id/events). Events are a change signal, not the data: the caller refetches.
// Reconnects on drop with backoff. The browser resends Last-Event-ID on its own reconnects; after a manual reconnect the
// caller's `onReconnect` refetches everything, so nothing depends on resuming mid-stream.
import { useEffect, useRef, useState } from "react";
import { MOCK, eventsUrl } from "./api";
import { mockSubscribe } from "./mocks/engine";
import type { StreamEvent } from "./types";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "mock";

export function useEvents(
  runId: string | null,
  onEvent: (e: StreamEvent) => void,
  onReconnect: () => void,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>(MOCK ? "mock" : "connecting");
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  handler.current = onEvent;
  reconnect.current = onReconnect;

  useEffect(() => {
    if (!runId) return;
    if (MOCK) {
      setStatus("mock");
      return mockSubscribe(runId, (e) => handler.current(e));
    }
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let everOpened = false;

    const open = () => {
      if (stopped) return;
      es = new EventSource(eventsUrl(runId));
      es.onopen = () => {
        attempt = 0;
        setStatus("live");
        if (everOpened) reconnect.current(); // we may have missed events while down
        everOpened = true;
      };
      es.addEventListener("audit", (m) => {
        try {
          handler.current(JSON.parse((m as MessageEvent<string>).data) as StreamEvent);
        } catch {
          handler.current({ _id: "", at: "", type: "UNPARSED" }); // still a signal to refetch
        }
      });
      es.onerror = () => {
        setStatus("reconnecting");
        // EventSource retries by itself while CONNECTING; once CLOSED (for example a 502 from the proxy) we reopen it.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          attempt += 1;
          timer = setTimeout(open, Math.min(5000, 500 * 2 ** Math.min(attempt, 4)));
        }
      };
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [runId]);

  return status;
}
