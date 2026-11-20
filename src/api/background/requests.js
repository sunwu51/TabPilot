/* global chrome */

// Each extension context owns its own registry. The worker registers its local
// operations; extension pages keep using runtime messaging to reach the worker.
const handlers = new Map();

export function registerBackgroundRequestHandler(type, handler) {
  handlers.set(type, handler);
}

export async function requestBackground(message) {
  const handler = handlers.get(message.type);
  if (handler) return handler(message);
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}
