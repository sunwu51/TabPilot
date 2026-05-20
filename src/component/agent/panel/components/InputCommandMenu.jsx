/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from "react";

export function useAutoScrollMenuOnPointerEdge(active) {
  const ref = useRef(null);
  const frameRef = useRef(null);
  const directionRef = useRef(0);

  useEffect(() => {
    if (!active) {
      directionRef.current = 0;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      return;
    }

    function step() {
      const el = ref.current;
      if (el && directionRef.current !== 0) {
        el.scrollTop += directionRef.current * 8;
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
      }
    }

    function onMouseMove(event) {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const edge = 28;
      const previous = directionRef.current;
      if (event.clientY > rect.bottom - edge) {
        directionRef.current = 1;
      } else if (event.clientY < rect.top + edge) {
        directionRef.current = -1;
      } else {
        directionRef.current = 0;
      }
      if (directionRef.current !== 0 && previous === 0 && frameRef.current == null) {
        frameRef.current = requestAnimationFrame(step);
      }
      if (directionRef.current === 0 && frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    }

    function onMouseLeave() {
      directionRef.current = 0;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const el = ref.current;
    el?.addEventListener("mousemove", onMouseMove);
    el?.addEventListener("mouseleave", onMouseLeave);
    return () => {
      el?.removeEventListener("mousemove", onMouseMove);
      el?.removeEventListener("mouseleave", onMouseLeave);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      directionRef.current = 0;
    };
  }, [active]);

  return ref;
}

/* eslint-disable react/prop-types */
export function InputCommandMenu({
  slashOpen,
  slashCommands,
  slashIndex,
  onSlashHover,
  onSlashSelect,
  tabOpen,
  tabs,
  tabIndex,
  onTabHover,
  onTabSelect
}) {
  const menuRef = useAutoScrollMenuOnPointerEdge(slashOpen || tabOpen);
  useEffect(() => {
    const activeItem = menuRef.current?.querySelector(".chat-input-command-item-active");
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [menuRef, slashIndex, tabIndex, slashOpen, tabOpen]);

  if (slashOpen) {
    return (
      <div ref={menuRef} className="chat-input-command-menu" role="listbox" aria-label="内置指令">
        {slashCommands.length === 0 ? (
          <div className="chat-input-command-empty">没有匹配的内置指令</div>
        ) : slashCommands.map((command, index) => (
          <button
            key={command.id}
            type="button"
            className={`chat-input-command-item ${index === slashIndex ? "chat-input-command-item-active" : ""}`}
            onMouseMove={() => onSlashHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSlashSelect(command)}
          >
            <span className="chat-input-command-name">{command.name}</span>
            <span className="chat-input-command-copy">
              <span className="chat-input-command-title-row">
                <span className="chat-input-command-title">{command.title}</span>
                {command.type !== "skill" && (
                  <span className="chat-input-command-badge">内置指令</span>
                )}
              </span>
              <span className="chat-input-command-desc">{command.description}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  if (tabOpen) {
    return (
      <div ref={menuRef} className="chat-input-command-menu chat-input-tab-menu" role="listbox" aria-label="选择标签页">
        {tabs.length === 0 ? (
          <div className="chat-input-command-empty">没有匹配的 http/https 标签页</div>
        ) : tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            className={`chat-input-command-item ${index === tabIndex ? "chat-input-command-item-active" : ""}`}
            onMouseMove={() => onTabHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onTabSelect(tab)}
          >
            <span className="chat-input-tab-favicon">
              {tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : "@"}
            </span>
            <span className="chat-input-command-copy">
              <span className="chat-input-command-title">{tab.title || "未命名标签页"}</span>
              <span className="chat-input-command-desc">{tab.url}</span>
            </span>
            <span className="chat-input-tab-id">#{tab.id}</span>
          </button>
        ))}
      </div>
    );
  }

  return null;
}
/* eslint-enable react/prop-types */






