/* global chrome */

function sendNetworkCapture(action, payload = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "network_capture", action, payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { error: "Empty network capture response" });
      });
    } catch (error) {
      resolve({ error: error?.message || String(error) });
    }
  });
}

export async function _execNetworkCaptureStart(args = {}) {
  return sendNetworkCapture("start", args);
}

export async function _execNetworkCaptureStop(args = {}) {
  return sendNetworkCapture("stop", args);
}

export async function _execNetworkCaptureGetDetails(args = {}) {
  return sendNetworkCapture("get_details", args);
}
