import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

const storageData = {};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveStorageGet(keys) {
  if (keys == null) return clone(storageData);
  if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
  if (Array.isArray(keys)) {
    return keys.reduce((result, key) => {
      result[key] = clone(storageData[key]);
      return result;
    }, {});
  }
  return Object.entries(keys).reduce((result, [key, defaultValue]) => {
    result[key] = Object.prototype.hasOwnProperty.call(storageData, key)
      ? clone(storageData[key])
      : clone(defaultValue);
    return result;
  }, {});
}

function makeAsyncCallback(fn) {
  return vi.fn((...args) => {
    const callback = typeof args.at(-1) === "function" ? args.pop() : null;
    const result = fn(...args);
    if (callback) callback(result);
    return Promise.resolve(result);
  });
}

export function resetChromeMock(initialStorage = {}) {
  Object.keys(storageData).forEach(key => delete storageData[key]);
  Object.assign(storageData, clone(initialStorage) || {});

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: vi.fn((path = "") => `chrome-extension://test-extension/${String(path).replace(/^\/+/, "")}`),
      sendMessage: vi.fn((message, callback) => {
        callback?.({ success: true, message });
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn((keys, callback) => {
          const result = resolveStorageGet(keys);
          if (callback) callback(result);
          return Promise.resolve(result);
        }),
        set: vi.fn((items, callback) => {
          Object.entries(items || {}).forEach(([key, value]) => {
            storageData[key] = clone(value);
          });
          callback?.();
          return Promise.resolve();
        }),
        remove: vi.fn((keys, callback) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(key => delete storageData[key]);
          callback?.();
          return Promise.resolve();
        }),
        clear: vi.fn((callback) => {
          Object.keys(storageData).forEach(key => delete storageData[key]);
          callback?.();
          return Promise.resolve();
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: {
      download: makeAsyncCallback(() => 1),
      search: makeAsyncCallback(() => []),
    },
    tabs: {
      query: makeAsyncCallback(() => []),
      get: makeAsyncCallback((id) => ({ id, url: "https://example.com/" })),
      update: makeAsyncCallback((id, updateInfo) => ({ id, ...updateInfo })),
      create: makeAsyncCallback((createProperties) => ({ id: 1, ...createProperties })),
      remove: makeAsyncCallback(() => undefined),
      sendMessage: vi.fn((tabId, message, callback) => callback?.({ success: true, tabId, message })),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    windows: {
      getAll: makeAsyncCallback(() => []),
      getCurrent: makeAsyncCallback(() => ({ id: 1 })),
      update: makeAsyncCallback((id, updateInfo) => ({ id, ...updateInfo })),
      create: makeAsyncCallback((createData) => ({ id: 1, ...createData })),
      remove: makeAsyncCallback(() => undefined),
    },
    tabGroups: {
      query: makeAsyncCallback(() => []),
      update: makeAsyncCallback((id, updateInfo) => ({ id, ...updateInfo })),
      move: makeAsyncCallback((id, moveProperties) => ({ id, ...moveProperties })),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: makeAsyncCallback(() => true),
      get: makeAsyncCallback(() => null),
      getAll: makeAsyncCallback(() => []),
      onAlarm: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: makeAsyncCallback(() => [{ result: null }]),
      insertCSS: makeAsyncCallback(() => undefined),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(() => Promise.resolve()),
    },
    webNavigation: {
      onDOMContentLoaded: { addListener: vi.fn() },
      onCompleted: { addListener: vi.fn() },
      onCommitted: { addListener: vi.fn() },
    },
    history: {
      search: makeAsyncCallback(() => []),
    },
  };

  return storageData;
}

beforeEach(() => {
  resetChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
