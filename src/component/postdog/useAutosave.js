import { useRef, useState } from "react";

/**
 * Debounced, serialized autosave keyed by entity ("request:<id>", "env:<id>", ...).
 *
 * - schedule(key, value): remember the latest value and save it after `delay` ms.
 * - flush(key): save now (returns a promise). flushAll() saves everything pending.
 * - pending(key): latest value that has not been persisted yet (or undefined).
 * - discard(key): forget a pending value (e.g. the entity was deleted).
 *
 * Saves run one at a time, and always persist the newest value for a key, so a
 * slow save can never overwrite newer input.
 */
export default function useAutosave({ save, onSaved, onError, delay = 400 }) {
  const pendingRef = useRef(new Map());
  const timersRef = useRef(new Map());
  const chainRef = useRef(Promise.resolve());
  const inflightRef = useRef(0);
  const errorRef = useRef(false);
  const callbacksRef = useRef({ save, onSaved, onError });
  callbacksRef.current = { save, onSaved, onError };
  const [status, setStatus] = useState("saved");

  function refreshStatus() {
    if (errorRef.current) setStatus("error");
    else if (inflightRef.current > 0) setStatus("saving");
    else if (pendingRef.current.size > 0) setStatus("pending");
    else setStatus("saved");
  }

  function clearTimer(key) {
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
  }

  function schedule(key, value) {
    pendingRef.current.set(key, value);
    clearTimer(key);
    timersRef.current.set(key, setTimeout(() => { void flush(key); }, delay));
    refreshStatus();
  }

  function flush(key) {
    clearTimer(key);
    if (!pendingRef.current.has(key)) return chainRef.current;
    inflightRef.current += 1;
    refreshStatus();
    const run = chainRef.current.then(async () => {
      const latest = pendingRef.current.get(key);
      if (latest === undefined) return;
      try {
        const result = await callbacksRef.current.save(key, latest);
        if (pendingRef.current.get(key) === latest) pendingRef.current.delete(key);
        errorRef.current = false;
        callbacksRef.current.onSaved?.(key, result, latest);
      } catch (error) {
        errorRef.current = true;
        callbacksRef.current.onError?.(key, error);
      }
    }).finally(() => {
      inflightRef.current -= 1;
      refreshStatus();
    });
    chainRef.current = run.catch(() => {});
    return run;
  }

  function flushAll() {
    return Promise.all([...pendingRef.current.keys()].map(key => flush(key)));
  }

  function pending(key) {
    return pendingRef.current.get(key);
  }

  function hasPending(key) {
    if (key) return pendingRef.current.has(key);
    return pendingRef.current.size > 0;
  }

  function discard(key) {
    clearTimer(key);
    pendingRef.current.delete(key);
    refreshStatus();
  }

  return { status, schedule, flush, flushAll, pending, hasPending, discard };
}
