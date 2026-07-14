/* global chrome */
import { Badge, Button, Card, Input, } from "@sunwu51/camel-ui"
import { useEffect, useRef, useState } from "react"
import { useLocalizedDom } from "../../i18n"
import './Search.css'

/**
 * Search component for finding tabs by keyword matching on title + url.
 * Also searches recent browser history (last 3 days).
 * Supports keyboard navigation (ArrowUp/Down, Enter, Escape, Cmd+Delete).
 */
function Search() {
  const rootRef = useLocalizedDom()
  const [filter, setFilter] = useState("");
  const [curWindow, setCurWindow] = useState(null);
  const [fromTabs, setFromTabs] = useState([])
  const [fromHistory, setFromHistory] = useState([])
  const [timestamp, setTimestamp] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const preserveIndexRef = useRef(null)

  useEffect(() => {
    (async function _run() {
      var tabs = await chrome.tabs.query({});
      if (filter.length == 0) {
        setFromTabs([])
        setFromHistory([])
        return;
      }

      var arr = filter.toLowerCase().split(" ").filter(i => i.length > 0);
      var urls = new Set();

      // Keyword search across open tabs
      var fromTabs = tabs.map(tab => ({ tab, score: lcs(arr, (tab.url + tab.title).toLowerCase()) }))
        .filter(it => it.score > 0)
        .sort((a, b) => { var d = b.score - a.score; if (d != 0) return d; else return b.tab.id - a.tab.id })
        .slice(0, 10);
      fromTabs.forEach(it => urls.add(it.tab.url));
      setFromTabs(fromTabs)

      // Search recent history (last 3 days), exclude already-open URLs
      var historys = await chrome.history.search({ text: '', maxResults: 1000, startTime: Date.now() - 3 * 24 * 60 * 60 * 1000 })
      var fromHistory = historys.filter(it => urls.has(it.url) == false)
        .map(it => ({ history: it, score: lcs(arr, (it.url + it.title).toLowerCase()) }))
        .filter(it => it.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      setFromHistory(fromHistory)

      const total = fromTabs.length + fromHistory.length;
      if (preserveIndexRef.current !== null) {
        setSelectedIndex(total > 0 ? Math.min(preserveIndexRef.current, total - 1) : -1);
        preserveIndexRef.current = null;
      } else {
        setSelectedIndex(-1);
      }
    })()
  }, [filter, timestamp])

  useEffect(() => {
    chrome.windows.getCurrent().then(setCurWindow)
    chrome.runtime.onMessage.addListener(function () {
      setTimestamp(new Date().getTime())
    });
  }, [])

  const searchRef = useRef(null);
  const totalResults = fromTabs.length + fromHistory.length;

  async function closeTab(tabId, e) {
    e?.preventDefault();
    e?.stopPropagation();
    e?.nativeEvent?.stopImmediatePropagation?.();
    preserveIndexRef.current = selectedIndex;
    await chrome.tabs.remove(tabId);
    setTimestamp(Date.now());
    requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
  }

  /** Switch to the tab or open history item at the given index */
  async function switchToItem(index) {
    if (index < fromTabs.length) {
      const item = fromTabs[index];
      if (curWindow && item.tab.windowId != curWindow.id) {
        await chrome.tabs.move(item.tab.id, { windowId: curWindow.id, index: -1 });
      }
      await chrome.tabs.update(item.tab.id, { active: true });
    } else {
      const hIndex = index - fromTabs.length;
      if (hIndex < fromHistory.length) {
        await chrome.tabs.create({ url: fromHistory[hIndex].history.url });
      }
    }
  }

  function handleKeyDown(e) {
    if (totalResults === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(Math.max(prev, -1) + 1, totalResults - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev <= 0 ? 0 : prev - 1, 0));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      switchToItem(selectedIndex);
    } else if (e.key === 'Escape') {
      setFilter("");
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.metaKey && selectedIndex >= 0 && selectedIndex < fromTabs.length) {
      e.preventDefault();
      closeTab(fromTabs[selectedIndex].tab.id);
    }
  }

  return (
    <>
      <div ref={rootRef}>
      <Card>
        <div style={{ padding: "0" }} ref={searchRef} tabIndex="0" onKeyDown={handleKeyDown}>
          <span className="text-sm text-gray-500 font-bold block mb-1">搜索</span>
          <Input
            aria-label="搜索标签页"
            onChange={setFilter}
            autoFocus={true}
            inputClassName="!min-h-8"
            placeholder="输入关键词搜索标签页"
          />
          {fromTabs.length > 0 &&
            <Card>
              <ul>
                {
                  fromTabs.map((item, index) => (
                    <li key={index} className="font-bold" onMouseMove={() => { searchRef.current?.focus(); setSelectedIndex(index); }} onMouseLeave={() => searchRef.current?.focus()}>
                      <Button onPress={async () => {
                        if (item.tab.windowId != curWindow.id) {
                          await chrome.tabs.move(item.tab.id, { windowId: curWindow.id, index: -1 })
                        }
                        await chrome.tabs.update(item.tab.id, { active: true });
                      }}
                        className={`search-result-button w-full static m-0 text-start active:transform-none p-0 ${selectedIndex === index ? 'search-result-button-selected' : ''}`}
                      >
                        <div className="flex flex-col px-1 min-h-8 rounded-md justify-center">
                          <div className="flex items-center">
                            {
                              curWindow.id === item.tab.windowId ?
                                <Badge className="search-result-badge search-result-badge-current min-w-20">当前-{item.score}</Badge> :
                                <Badge className="search-result-badge search-result-badge-other min-w-20">其他-{item.score}</Badge>
                            }
                            &nbsp;
                            {item.tab.favIconUrl ? <img width="16px" src={item.tab.favIconUrl}></img> : null}
                            <p className="flex-1" style={{
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                              overflow: 'hidden'
                            }}>{item.tab.title}</p>
                            {selectedIndex === index && (
                              <span
                                role="button"
                                tabIndex="-1"
                                className="flex-shrink-0 ml-1 w-5 h-5 rounded flex items-center justify-center bg-red-400 hover:bg-red-600 text-white text-sm leading-none"
                                onPointerDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => closeTab(item.tab.id, e)}
                                title="关闭此标签页"
                              >
                                &times;
                              </span>
                            )}
                          </div>
                          <div className="details">
                            <p style={{
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                              overflow: 'hidden'
                            }}>
                              url: {item.tab.url}
                            </p>
                          </div>
                        </div>
                      </Button>
                    </li>
                  ))
                }
                {
                  fromHistory.map((item, index) => {
                    const globalIndex = fromTabs.length + index;
                    return (
                    <li key={"h" + index} className="font-bold" onMouseMove={() => setSelectedIndex(globalIndex)}>
                      <Button onPress={async () => {
                        await chrome.tabs.create({ url: item.history.url })
                      }}
                        className={`search-result-button w-full static m-0 text-start active:transform-none p-0 ${selectedIndex === globalIndex ? 'search-result-button-selected' : ''}`}
                      >
                        <div className="flex flex-col px-1 min-h-8 rounded-md justify-center">
                          <div className="flex items-center">
                            <Badge className="search-result-badge search-result-badge-history min-w-20">{formatTime(Date.now() - item.history.lastVisitTime)}</Badge>
                            &nbsp;
                            <p style={{
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                              overflow: 'hidden'
                            }}>{item.history.title}</p>
                          </div>
                          <div className="details">
                            <p style={{
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                              overflow: 'hidden'
                            }}>
                              url: {item.history.url}
                            </p>
                          </div>
                        </div>
                      </Button>
                    </li>
                  )})
                }
              </ul>
            </Card>}
        </div>
      </Card>
      </div>
    </>
  )
}

function formatTime(ms) {
  var m = ms / 1000 / 60;
  if (m < 180) return Math.ceil(m) + '分钟前'
  if (m < 24 * 60) return Math.floor(m / 60) + '小时前'
  return Math.floor(m / 60 / 24) + '天前'
}

/** Count how many search words appear in the text (simple keyword match) */
function lcs(words, text) {
  var res = 0;
  for (var i = 0; i < words.length; i++) {
    res += text.indexOf(words[i]) >= 0 ? 1 : 0;
  }
  return res;
}

export default Search
