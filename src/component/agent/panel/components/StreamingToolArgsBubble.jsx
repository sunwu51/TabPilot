/* eslint-disable react/prop-types */
export function StreamingToolArgsBubble({ state }) {
  return (
    <div className="chat-msg chat-msg-assistant">
      <div className="streaming-tool-args-bubble">
        <div className="streaming-tool-args-title loading-dots">正在生成函数参数：{state.name}</div>
        <pre className="streaming-tool-args-content">{state.preview}</pre>
      </div>
    </div>
  );
}
