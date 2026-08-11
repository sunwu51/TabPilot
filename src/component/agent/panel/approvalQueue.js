function getSessionQueue(queues, sessionId) {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = { active: null, pending: [] };
    queues.set(sessionId, queue);
  }
  return queue;
}

function activateNext(queues, sessionId, options = {}) {
  const queue = queues.get(sessionId);
  if (!queue || queue.active) return queue?.active || null;

  while (queue.pending.length > 0) {
    const next = queue.pending.shift();
    if (options.isValid && !options.isValid(next)) {
      next.resolve(next.cancelResult);
      continue;
    }
    queue.active = next;
    options.onActivate?.(next);
    return next;
  }

  queues.delete(sessionId);
  options.onIdle?.();
  return null;
}

export function enqueueApproval(queues, sessionId, approval, onActivate) {
  return new Promise((resolve) => {
    const queue = getSessionQueue(queues, sessionId);
    const entry = { ...approval, resolve, settling: false };
    queue.pending.push(entry);
    activateNext(queues, sessionId, { onActivate });
  });
}

export function claimCurrentApproval(queues, sessionId) {
  const current = queues.get(sessionId)?.active || null;
  if (!current || current.settling) return null;
  current.settling = true;
  return current;
}

export function settleCurrentApproval(queues, sessionId, result, options = {}) {
  const queue = queues.get(sessionId);
  const current = queue?.active;
  if (!current) return { current: null, next: null };

  queue.active = null;
  current.resolve(result);
  const next = activateNext(queues, sessionId, options);
  return { current, next };
}

export function cancelSessionApprovals(queues, sessionId) {
  const queue = queues.get(sessionId);
  if (!queue) return 0;
  queues.delete(sessionId);
  const entries = [queue.active, ...queue.pending].filter(Boolean);
  for (const entry of entries) entry.resolve(entry.cancelResult);
  return entries.length;
}

export function cancelAllApprovals(queues) {
  let count = 0;
  for (const sessionId of [...queues.keys()]) {
    count += cancelSessionApprovals(queues, sessionId);
  }
  return count;
}
