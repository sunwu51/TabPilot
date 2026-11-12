/* global chrome */
/* eslint-disable react/prop-types */
import { Card } from "@sunwu51/camel-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useI18n } from "../../i18n";
import {
  BOARD_KEY,
  DEFAULT_COLOR,
  DEFAULT_PREFS,
  PIN_COMMAND,
  THUMB_PREFIX,
  addLane,
  applyOrder,
  displayTitle,
  doneTime,
  hostOf,
  laneColor,
  loadBoard,
  loadPrefs,
  loadThumbs,
  openNote,
  pinActiveTab,
  reconcileStickies,
  refreshThumbnail,
  removeLane,
  removeNote,
  renameLane,
  reorderNotes,
  savePrefs,
  setNoteDone,
  updateNote,
} from "../../api/sticky/store";
import "./StickyBoard.css";

const SIZES = ["s", "m", "l"];
const LEAVE_MS = 300;
const ENTER_MS = 700;

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Stable small rotation per note so the board looks hand-placed but never jumps. */
function tiltOf(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 320) / 100 - 1.6).toFixed(2);
}

/**
 * Animate cards from their previous grid position to the new one (FLIP).
 * Only plays when `layoutKey` changes (cards added, removed, reordered or
 * resized). Positions are still recorded on every render, but an ordinary
 * re-render must never animate, or unrelated layout shifts look like jitter.
 */
function useFlip(containerRef, layoutKey) {
  const previous = useRef(new Map());
  const previousKey = useRef(layoutKey);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const next = new Map();
    const animate = previousKey.current !== layoutKey && !prefersReducedMotion();
    previousKey.current = layoutKey;
    container.querySelectorAll("[data-flip-id]").forEach(node => {
      const rect = node.getBoundingClientRect();
      const position = { x: rect.left - origin.left, y: rect.top - origin.top };
      next.set(node.dataset.flipId, position);
      const before = previous.current.get(node.dataset.flipId);
      if (!before || !animate || typeof node.animate !== "function") return;
      const dx = before.x - position.x;
      const dy = before.y - position.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
    previous.current = next;
  });
}

const Icon = {
  pin: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" /><path d="M9 3h6l-1 7 4 4H6l4-4z" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h4l2-3h6l2 3h4v11H3z" /><circle cx="12" cy="13" r="3.2" />
    </svg>
  ),
  move: (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h7l2 3h9v9H3z" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  ),
};

function InlineInput({ initial, placeholder, ariaLabel, className, onCommit, onCancel }) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const finish = (commit) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value.trim());
    else onCancel?.();
  };
  return (
    <input
      autoFocus
      className={className}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={event => event.target.select()}
      onChange={event => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    />
  );
}

function StickyCard({ note, color, thumb, lanes, L, state, enterDelay, onOpen, onRename, onNote, onMove, onDone, onDelete, onRecapture }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuSide, setMenuSide] = useState("right");
  const cardRef = useRef(null);
  const live = note.tabId != null;
  const host = hostOf(note.url);
  const title = displayTitle(note);

  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), 2500);
    return () => clearTimeout(timer);
  }, [confirming]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = event => { if (!cardRef.current?.contains(event.target)) setMenuOpen(false); };
    const onKeyDown = event => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  function toggleMenu() {
    if (!menuOpen) {
      // Open towards the middle of the board so the menu is never clipped by the panel edge.
      const card = cardRef.current?.getBoundingClientRect();
      const boardRect = cardRef.current?.closest(".stk-board")?.getBoundingClientRect();
      if (card && boardRect) {
        setMenuSide(card.left + card.width / 2 < boardRect.left + boardRect.width / 2 ? "left" : "right");
      }
    }
    setMenuOpen(!menuOpen);
  }

  const laneOptions = [{ id: null, name: L("未分组", "No lane"), color: DEFAULT_COLOR }, ...lanes];

  const classes = [
    "stk-card",
    `stk-c-${color}`,
    live ? "is-live" : "is-dead",
    state.entering ? "is-entering" : "",
    state.leaving ? "is-leaving" : "",
    state.reviving ? "is-reviving" : "",
    state.flash ? "is-flash" : "",
    menuOpen ? "is-menu-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      ref={cardRef}
      className={classes}
      style={{ "--tilt": `${tiltOf(note.id)}deg`, animationDelay: state.entering ? `${enterDelay}ms` : undefined }}
      data-testid="sticky-card"
    >
      <span className="stk-tape" aria-hidden="true" />
      <div className="stk-shot">
        <button
          type="button"
          className="stk-open"
          onClick={onOpen}
          title={note.url}
          aria-label={`${live ? L("切换到", "Switch to") : L("重新打开", "Reopen")} ${title}`}
        >
          {thumb ? (
            <img src={thumb} alt="" draggable="false" />
          ) : (
            <span className="stk-shot-empty">
              {note.favIconUrl ? <img src={note.favIconUrl} alt="" /> : <span className="stk-shot-letter">{(host || "?").slice(0, 1).toUpperCase()}</span>}
              <span className="stk-shot-host">{host}</span>
            </span>
          )}
          <span className="stk-shot-label">{live ? L("切换到此页", "Switch to tab") : L("点击复活", "Click to reopen")}</span>
        </button>
        <div className="stk-tools">
          <button type="button" className="stk-tool" title={L("改标题", "Rename")} aria-label={L("改标题", "Rename")} onClick={() => setEditing(true)}>{Icon.edit}</button>
          {live && (
            <button type="button" className="stk-tool" title={L("重新截图", "Retake screenshot")} aria-label={L("重新截图", "Retake screenshot")} onClick={onRecapture}>{Icon.camera}</button>
          )}
          {lanes.length > 0 && (
            <button
              type="button"
              className={`stk-tool ${menuOpen ? "is-active" : ""}`}
              title={L("移动到分组", "Move to lane")}
              aria-label={L("移动到分组", "Move to lane")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={toggleMenu}
            >
              {Icon.move}
            </button>
          )}
          <button type="button" className="stk-tool stk-tool-done" title={L("完成", "Done")} aria-label={L("完成", "Done")} onClick={onDone}>{Icon.check}</button>
          <button
            type="button"
            className={`stk-tool stk-tool-delete ${confirming ? "is-confirming" : ""}`}
            title={confirming ? L("再点一次删除", "Click again to delete") : L("删除", "Delete")}
            aria-label={confirming ? L("确认删除", "Confirm delete") : L("删除", "Delete")}
            onClick={() => (confirming ? onDelete() : setConfirming(true))}
          >
            {Icon.close}
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className={`stk-menu stk-menu-${menuSide}`} role="menu" aria-label={L("移动到分组", "Move to lane")}>
          <div className="stk-menu-title">{L("移动到", "Move to")}</div>
          {laneOptions.map(lane => {
            const checked = (note.laneId || null) === lane.id;
            return (
              <button
                key={lane.id || "none"}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`stk-menu-item stk-c-${lane.color} ${checked ? "is-checked" : ""}`}
                onClick={() => { setMenuOpen(false); if (!checked) onMove(lane.id); }}
              >
                <span className="stk-chip-dot" aria-hidden="true" />
                <span className="stk-menu-name">{lane.name}</span>
                {checked && <span className="stk-menu-check">{Icon.check}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="stk-body">
        {editing ? (
          <InlineInput
            className="stk-title-input"
            initial={title}
            ariaLabel={L("便利贴标题", "Sticky title")}
            placeholder={note.title}
            onCommit={value => { setEditing(false); onRename(value); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="stk-title" title={L("双击改标题", "Double-click to rename")} onDoubleClick={() => setEditing(true)}>{title}</div>
        )}
        <input
          key={note.note}
          className="stk-note"
          defaultValue={note.note}
          placeholder={L("写点备注…", "Add a note…")}
          aria-label={L("备注", "Note")}
          onBlur={event => { if (event.target.value !== note.note) onNote(event.target.value); }}
          onKeyDown={event => { if (event.key === "Enter") event.target.blur(); }}
        />
        <div className="stk-meta">
          <span className="stk-dot" aria-hidden="true" />
          <span className="stk-host">{live ? host : L("已关闭", "Closed")}</span>
        </div>
      </div>
    </article>
  );
}

export default function StickyBoard() {
  const { locale } = useI18n();
  const L = useCallback((zh, en) => (locale === "en" ? en : zh), [locale]);

  const [board, setBoard] = useState(null);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [thumbs, setThumbs] = useState({});
  const [leaving, setLeaving] = useState(() => new Set());
  const [revivingId, setRevivingId] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const [laneEditor, setLaneEditor] = useState(null); // null | "add" | "rename"
  const [confirmLaneDelete, setConfirmLaneDelete] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [shortcut, setShortcut] = useState("");

  const [drag, setDrag] = useState(null); // { id, order } while a card is being dragged
  const lastSwapAt = useRef(0);

  const gridRef = useRef(null);
  const enterTimes = useRef(new Map());
  const firstPaint = useRef(true);
  const requestedThumbs = useRef(new Set());
  const refresh = useCallback(async () => {
    setBoard(await loadBoard());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const storedPrefs = await loadPrefs();
      if (alive) setPrefs(storedPrefs);
      await reconcileStickies().catch(() => {});
      const loaded = await loadBoard();
      if (alive) setBoard(loaded);
    })();

    const onChanged = (changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[BOARD_KEY]) void loadBoard().then(next => { if (alive) setBoard(next); });
      const thumbPatch = {};
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(THUMB_PREFIX)) thumbPatch[key.slice(THUMB_PREFIX.length)] = change.newValue || null;
      }
      if (Object.keys(thumbPatch).length) setThumbs(prev => ({ ...prev, ...thumbPatch }));
    };
    chrome.storage.onChanged.addListener(onChanged);

    chrome.commands?.getAll?.().then(commands => {
      const key = commands?.find(command => command.name === PIN_COMMAND)?.shortcut;
      if (alive && key) setShortcut(key);
    }).catch(() => {});

    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // Lazily load thumbnails for notes that have one and are not in memory yet.
  useEffect(() => {
    if (!board) return;
    const missing = board.notes
      .filter(note => note.hasThumb && !requestedThumbs.current.has(note.id))
      .map(note => note.id);
    if (!missing.length) return;
    missing.forEach(id => requestedThumbs.current.add(id));
    let alive = true;
    void loadThumbs(missing).then(loaded => {
      if (alive) setThumbs(prev => ({ ...loaded, ...prev }));
    });
    return () => { alive = false; };
  }, [board]);

  const lanes = useMemo(() => board?.lanes || [], [board]);
  const notes = useMemo(() => board?.notes || [], [board]);
  const openNotes = notes.filter(note => !note.done);
  const doneNotes = notes.filter(note => note.done).sort((a, b) => doneTime(b) - doneTime(a));
  const hasUnlaned = lanes.length > 0 && openNotes.some(note => !note.laneId);

  const activeLane = prefs.activeLane === "all"
    || (prefs.activeLane === "none" && hasUnlaned)
    || lanes.some(lane => lane.id === prefs.activeLane)
    ? prefs.activeLane
    : "all";
  const selectedLane = lanes.find(lane => lane.id === activeLane) || null;

  const filtered = openNotes.filter(note => {
    if (activeLane === "all") return true;
    if (activeLane === "none") return !note.laneId;
    return note.laneId === activeLane;
  });
  // While dragging, show the order being previewed instead of the stored one.
  const visible = drag
    ? [
      ...drag.order.map(id => filtered.find(note => note.id === id)).filter(Boolean),
      ...filtered.filter(note => !drag.order.includes(note.id)),
    ]
    : filtered;
  useFlip(gridRef, `${prefs.size}:${visible.map(note => note.id).join("|")}`);

  // Entrance bookkeeping: remember when each card first appeared so it only animates once.
  const now = Date.now();
  if (board) {
    visible.forEach((note, index) => {
      if (enterTimes.current.has(note.id)) return;
      const delay = firstPaint.current ? Math.min(index, 8) * 45 : 0;
      enterTimes.current.set(note.id, { at: now, delay });
    });
    firstPaint.current = false;
  }

  function updatePrefs(patch) {
    setPrefs(prev => ({ ...prev, ...patch }));
    void savePrefs(patch);
  }

  function selectLane(id) {
    setLaneEditor(null);
    setConfirmLaneDelete(false);
    updatePrefs({ activeLane: id });
  }

  function leaveThen(id, action) {
    setLeaving(prev => new Set(prev).add(id));
    setTimeout(async () => {
      try {
        await action();
        await refresh();
      } finally {
        setLeaving(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }, prefersReducedMotion() ? 0 : LEAVE_MS);
  }

  function pulse(setter, id, ms) {
    setter(id);
    setTimeout(() => setter(current => (current === id ? null : current)), ms);
  }

  function handleDragStart(event, noteId) {
    if (event.target.closest?.("input, .stk-menu")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", noteId);
    const order = filtered.map(note => note.id);
    const start = { x: event.clientX, y: event.clientY, onOpen: !!event.target.closest?.(".stk-open") };
    // Deferred so the browser snapshots the card before it is dimmed.
    setTimeout(() => setDrag({ id: noteId, order, start }), 0);
  }

  function handleDragOver(event, overId) {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!overId || overId === drag.id) return;
    // Let the slide animation settle so cards do not swap back and forth under the pointer.
    if (Date.now() - lastSwapAt.current < 220) return;
    lastSwapAt.current = Date.now();
    setDrag(current => {
      if (!current) return current;
      const target = current.order.indexOf(overId);
      if (target < 0) return current;
      const order = current.order.filter(id => id !== current.id);
      order.splice(target, 0, current.id);
      return { ...current, order };
    });
  }

  function handleDragEnd(event) {
    const finished = drag;
    setDrag(null);
    if (!finished) return;
    const before = filtered.map(note => note.id).join("|");
    if (finished.order.join("|") === before) {
      // A click where the mouse slipped a few pixels starts a drag and swallows
      // the click. Treat that as the click it was meant to be.
      const moved = Math.hypot(event.clientX - finished.start.x, event.clientY - finished.start.y);
      const note = filtered.find(item => item.id === finished.id);
      if (finished.start.onOpen && moved < 12 && note) void handleOpen(note);
      return;
    }
    setBoard(current => (current ? { ...current, notes: applyOrder(current.notes, finished.order) } : current));
    void reorderNotes(finished.order).then(refresh);
  }

  async function afterPin({ note, duplicate }) {
    if (duplicate) {
      toast(L("这个页面已经贴过了", "This page is already on the board"), { icon: "📌" });
      if (activeLane !== "all" && note.laneId !== (selectedLane?.id ?? null)) updatePrefs({ activeLane: "all" });
      pulse(setFlashId, note.id, 700);
      return;
    }
    await refresh();
    if (!note.hasThumb) toast(L("已贴住（没有截图）", "Stuck (no screenshot)"), { icon: "📌" });
  }

  async function handlePin() {
    if (pinning) return;
    setPinning(true);
    try {
      await afterPin(await pinActiveTab({ laneId: selectedLane ? selectedLane.id : null }));
    } catch {
      toast.error(L("没有可以贴住的页面", "No tab to stick"));
    } finally {
      setPinning(false);
    }
  }

  async function handleOpen(note) {
    try {
      const { revived } = await openNote(note.id);
      if (revived) {
        pulse(setRevivingId, note.id, 900);
        toast.success(L("已重新打开", "Reopened"));
      }
      await refresh();
    } catch {
      toast.error(L("打开失败", "Could not open the page"));
    }
  }

  async function handleRecapture(note) {
    const ok = await refreshThumbnail(note.id).catch(() => false);
    if (ok) toast.success(L("截图已更新", "Screenshot updated"));
    else toast.error(L("截图失败", "Could not capture this page"));
    await refresh();
  }

  async function commitLane(name) {
    const mode = laneEditor;
    setLaneEditor(null);
    if (!name) return;
    if (mode === "rename" && selectedLane) {
      await renameLane(selectedLane.id, name);
    } else {
      const lane = await addLane(name);
      updatePrefs({ activeLane: lane.id });
    }
    await refresh();
  }

  async function deleteSelectedLane() {
    if (!selectedLane) return;
    if (!confirmLaneDelete) {
      setConfirmLaneDelete(true);
      return;
    }
    setConfirmLaneDelete(false);
    await removeLane(selectedLane.id);
    updatePrefs({ activeLane: "all" });
    await refresh();
  }

  const sizeIndex = Math.max(0, SIZES.indexOf(prefs.size));
  const pinTitle = L("把当前页贴到这里", "Stick the current tab here") + (shortcut ? ` (${shortcut})` : "");

  return (
    <div className="stk-board">
      <Card>
        <div className="stk-head">
          <span className="stk-heading">{L("便利贴", "Stickies")}</span>
          <div className="stk-head-actions">
            <div className="stk-seg" role="group" aria-label={L("缩略图大小", "Thumbnail size")} style={{ "--i": sizeIndex }}>
              <span className="stk-seg-thumb" aria-hidden="true" />
              {SIZES.map(size => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={prefs.size === size}
                  title={{ s: L("小", "Small"), m: L("中", "Medium"), l: L("大", "Large") }[size]}
                  onClick={() => updatePrefs({ size })}
                >
                  {size.toUpperCase()}
                </button>
              ))}
            </div>
            <button type="button" className="stk-pin-btn" onClick={handlePin} disabled={pinning} title={pinTitle}>
              <span className="stk-pin-icon">{Icon.pin}</span>
              {L("贴住当前页", "Stick this tab")}
            </button>
          </div>
        </div>

        <div className="stk-lanes">
          <button type="button" className={`stk-chip stk-chip-all ${activeLane === "all" ? "is-active" : ""}`} onClick={() => selectLane("all")}>
            {L("全部", "All")}<span className="stk-chip-count">{openNotes.length}</span>
          </button>
          {lanes.map(lane => (
            laneEditor === "rename" && selectedLane?.id === lane.id ? (
              <InlineInput
                key={lane.id}
                className="stk-chip-input"
                initial={lane.name}
                ariaLabel={L("分组名称", "Lane name")}
                onCommit={commitLane}
                onCancel={() => setLaneEditor(null)}
              />
            ) : (
              <button
                key={lane.id}
                type="button"
                className={`stk-chip stk-c-${lane.color} ${activeLane === lane.id ? "is-active" : ""}`}
                onClick={() => selectLane(lane.id)}
                onDoubleClick={() => { selectLane(lane.id); setLaneEditor("rename"); }}
              >
                <span className="stk-chip-dot" aria-hidden="true" />
                {lane.name}
                <span className="stk-chip-count">{openNotes.filter(note => note.laneId === lane.id).length}</span>
              </button>
            )
          ))}
          {hasUnlaned && (
            <button type="button" className={`stk-chip stk-c-${DEFAULT_COLOR} ${activeLane === "none" ? "is-active" : ""}`} onClick={() => selectLane("none")}>
              <span className="stk-chip-dot" aria-hidden="true" />
              {L("未分组", "No lane")}<span className="stk-chip-count">{openNotes.filter(note => !note.laneId).length}</span>
            </button>
          )}
          {laneEditor === "add" ? (
            <InlineInput
              className="stk-chip-input"
              initial=""
              placeholder={L("分组名，如 MR review", "Lane name, e.g. MR review")}
              ariaLabel={L("新分组名称", "New lane name")}
              onCommit={commitLane}
              onCancel={() => setLaneEditor(null)}
            />
          ) : (
            <button type="button" className="stk-chip stk-chip-add" title={L("新建分组", "New lane")} aria-label={L("新建分组", "New lane")} onClick={() => { setConfirmLaneDelete(false); setLaneEditor("add"); }}>+</button>
          )}
          {selectedLane && laneEditor == null && (
            <span className="stk-lane-actions">
              <button type="button" onClick={() => setLaneEditor("rename")}>{L("重命名", "Rename")}</button>
              <button type="button" className={confirmLaneDelete ? "is-danger" : ""} onClick={deleteSelectedLane} onBlur={() => setConfirmLaneDelete(false)}>
                {confirmLaneDelete ? L("确认删除分组？", "Delete lane?") : L("删除分组", "Delete lane")}
              </button>
            </span>
          )}
        </div>

        {board && visible.length === 0 && (
          <div className="stk-empty">
            <span className="stk-empty-pin">{Icon.pin}</span>
            <p>
              {openNotes.length === 0
                ? L("把正在处理的页面贴在这里，稍后一键回来。", "Stick the pages you're working on here and jump back in one click.")
                : L("这个分组里还没有便利贴。", "No stickies in this lane yet.")}
            </p>
            {shortcut && <p className="stk-empty-hint">{L("快捷键", "Shortcut")} <kbd>{shortcut}</kbd></p>}
          </div>
        )}

        <div
          ref={gridRef}
          className={`stk-grid stk-size-${SIZES[sizeIndex]} ${drag ? "is-sorting" : ""}`}
          onDragOver={event => handleDragOver(event, null)}
          onDrop={event => event.preventDefault()}
        >
          {visible.map(note => {
            const entered = enterTimes.current.get(note.id);
            const entering = !!entered && now - entered.at < ENTER_MS + entered.delay;
            return (
              <div
                key={note.id}
                className={`stk-slot ${drag?.id === note.id ? "is-dragging" : ""}`}
                data-flip-id={note.id}
                draggable
                // Dragging must not hijack text selection inside the title and note inputs.
                onMouseDown={event => { event.currentTarget.draggable = !event.target.closest("input, .stk-menu"); }}
                onDragStart={event => handleDragStart(event, note.id)}
                onDragOver={event => { event.stopPropagation(); handleDragOver(event, note.id); }}
                onDragEnd={handleDragEnd}
              >
                <StickyCard
                  note={note}
                  color={laneColor(board, note.laneId)}
                  thumb={thumbs[note.id] || null}
                  lanes={lanes}
                  L={L}
                  enterDelay={entered?.delay || 0}
                  state={{
                    entering,
                    leaving: leaving.has(note.id),
                    reviving: revivingId === note.id,
                    flash: flashId === note.id,
                  }}
                  onOpen={() => handleOpen(note)}
                  onRename={value => updateNote(note.id, { customTitle: value === note.title ? "" : value }).then(refresh)}
                  onNote={value => updateNote(note.id, { note: value.trim() }).then(refresh)}
                  onMove={laneId => updateNote(note.id, { laneId }).then(refresh)}
                  onDone={() => leaveThen(note.id, () => setNoteDone(note.id, true))}
                  onDelete={() => leaveThen(note.id, () => removeNote(note.id))}
                  onRecapture={() => handleRecapture(note)}
                />
              </div>
            );
          })}
        </div>

        {doneNotes.length > 0 && (
          <div className="stk-done">
            <button type="button" className={`stk-done-toggle ${showDone ? "is-open" : ""}`} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              <span className="stk-chevron" aria-hidden="true">▸</span>
              {L("已完成", "Done")} ({doneNotes.length})
            </button>
            {showDone && <span className="stk-done-hint">{L("完成 3 天后自动删除", "Deleted automatically 3 days after completion")}</span>}
            {showDone && (
              <ul className="stk-done-list">
                {doneNotes.map(note => (
                  <li key={note.id} className={leaving.has(note.id) ? "is-leaving" : ""}>
                    <span className="stk-done-title" title={note.url}>{displayTitle(note)}</span>
                    <button type="button" onClick={() => setNoteDone(note.id, false).then(reconcileStickies).then(refresh)}>{L("恢复", "Restore")}</button>
                    <button type="button" className="is-danger" onClick={() => leaveThen(note.id, () => removeNote(note.id))}>{L("删除", "Delete")}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
