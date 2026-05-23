/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { Button } from "@sunwu51/camel-ui";
import { isImageFile, getClipboardImageFiles, imageFileToAttachmentItem } from "../messages/userMessage";

export function ImageEditDialog({ request, disabled = false, onCancel, onConfirm }) {
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState("");
  const [maskEnabled, setMaskEnabled] = useState(false);
  const [maskTouched, setMaskTouched] = useState(false);
  const [referenceImages, setReferenceImages] = useState([]);
  const [referenceImagesLoading, setReferenceImagesLoading] = useState(false);
  const canvasRef = useRef(null);
  const referenceImageInputRef = useRef(null);
  const drawingRef = useRef(false);
  const maskPathsRef = useRef([]);
  const activeMaskPathRef = useRef([]);
  const pendingReferenceImageBatchesRef = useRef(0);
  const maskSupported = request?.maskSupported !== false;

  useEffect(() => {
    setSuggestion("");
    setError("");
    setMaskEnabled(false);
    setMaskTouched(false);
    setReferenceImages([]);
    setReferenceImagesLoading(false);
    drawingRef.current = false;
    maskPathsRef.current = [];
    activeMaskPathRef.current = [];
    pendingReferenceImageBatchesRef.current = 0;
    clearMaskCanvas();
  }, [request?.src]);

  useEffect(() => {
    if (maskSupported) return;
    setMaskEnabled(false);
    setMaskTouched(false);
    maskPathsRef.current = [];
    activeMaskPathRef.current = [];
    drawingRef.current = false;
    clearMaskCanvas();
  }, [maskSupported]);

  async function addReferenceImageFiles(files) {
    const imageFiles = Array.from(files || []).filter(isImageFile);
    if (imageFiles.length === 0) return;

    pendingReferenceImageBatchesRef.current += 1;
    setReferenceImagesLoading(true);
    const newItems = [];
    try {
      for (const file of imageFiles) {
        try {
          const item = await imageFileToAttachmentItem(file);
          if (item) newItems.push(item);
        } catch (err) {
          console.error("Failed to process reference image:", err);
          setError(`参考图处理失败: ${file.name || "图片"}`);
        }
      }

      if (newItems.length > 0) {
        setReferenceImages(prev => [...prev, ...newItems]);
        if (error) setError("");
      }
    } finally {
      pendingReferenceImageBatchesRef.current = Math.max(0, pendingReferenceImageBatchesRef.current - 1);
      if (pendingReferenceImageBatchesRef.current === 0) {
        setReferenceImagesLoading(false);
      }
    }
  }

  function handleReferenceImageSelect(event) {
    const files = Array.from(event.target.files || []);
    void addReferenceImageFiles(files);
    event.target.value = "";
  }

  function handleReferenceImagePaste(event) {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addReferenceImageFiles(imageFiles);
  }

  function handleReferenceImageDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleReferenceImageDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    void addReferenceImageFiles(event.dataTransfer?.files);
  }

  function removeReferenceImage(id) {
    setReferenceImages(prev => prev.filter(item => item.id !== id));
  }

  function syncMaskCanvas(event) {
    const image = event.currentTarget;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(1, image.naturalWidth || image.clientWidth || 1);
    const height = Math.max(1, image.naturalHeight || image.clientHeight || 1);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    renderMaskPreview();
  }

  function clearMaskCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function handleClearMask(event) {
    event.preventDefault();
    maskPathsRef.current = [];
    activeMaskPathRef.current = [];
    drawingRef.current = false;
    clearMaskCanvas();
    setMaskTouched(false);
  }

  function getCanvasPoint(event) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function renderMaskPreview() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const path of maskPathsRef.current) {
      drawClosedMaskPath(ctx, path, {
        fillStyle: "rgba(239, 68, 68, 0.28)",
        strokeStyle: "rgba(220, 38, 38, 0.75)"
      });
    }

    const activePath = activeMaskPathRef.current;
    if (activePath.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(220, 38, 38, 0.9)";
    ctx.beginPath();
    ctx.moveTo(activePath[0].x, activePath[0].y);
    for (let i = 1; i < activePath.length; i++) {
      ctx.lineTo(activePath[i].x, activePath[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawClosedMaskPath(ctx, path, { fillStyle, strokeStyle }) {
    if (!Array.isArray(path) || path.length < 3) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    ctx.fillStyle = fillStyle;
    ctx.strokeStyle = strokeStyle;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i].x, path[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function handleMaskPointerDown(event) {
    if (!maskEnabled) return;
    event.preventDefault();
    const point = getCanvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    activeMaskPathRef.current = [point];
    renderMaskPreview();
  }

  function handleMaskPointerMove(event) {
    if (!maskEnabled || !drawingRef.current) return;
    event.preventDefault();
    const point = getCanvasPoint(event);
    if (!point) return;
    const activePath = activeMaskPathRef.current;
    const lastPoint = activePath[activePath.length - 1];
    if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 2) return;
    activePath.push(point);
    renderMaskPreview();
  }

  function handleMaskPointerEnd(event) {
    if (!drawingRef.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const activePath = activeMaskPathRef.current;
    if (activePath.length >= 3) {
      maskPathsRef.current = [...maskPathsRef.current, activePath];
      setMaskTouched(true);
    }
    activeMaskPathRef.current = [];
    drawingRef.current = false;
    renderMaskPreview();
  }

  function exportMaskDataUrl() {
    const canvas = canvasRef.current;
    const paths = maskPathsRef.current;
    if (!canvas || !maskTouched || paths.length === 0) return "";
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return "";
    maskCtx.fillStyle = "rgba(255, 255, 255, 1)";
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.globalCompositeOperation = "destination-out";
    for (const path of paths) {
      drawClosedMaskPath(maskCtx, path, {
        fillStyle: "rgba(0, 0, 0, 1)",
        strokeStyle: "rgba(0, 0, 0, 1)"
      });
    }
    maskCtx.globalCompositeOperation = "source-over";
    return maskCanvas.toDataURL("image/png");
  }

  function handleConfirm() {
    if (referenceImagesLoading) return;
    const trimmed = suggestion.trim();
    if (!trimmed) {
      setError("请输入修改建议");
      return;
    }
    onConfirm?.({
      suggestion: trimmed,
      maskDataUrl: maskEnabled && maskPathsRef.current.length > 0 ? exportMaskDataUrl() : "",
      referenceImages
    });
  }

  return (
    <div className="dialog-backdrop image-edit-backdrop" onClick={onCancel}>
      <div
        className="dialog-dialog image-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-edit-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="dialog-close-button"
          onClick={onCancel}
          aria-label="关闭"
        >
          X
        </button>
        <div className="image-edit-dialog-body">
          <div id="image-edit-dialog-title" className="image-edit-title">编辑图片</div>
          <div className="image-edit-preview">
            <img
              src={request?.src}
              alt={request?.alt || "图片"}
              onLoad={syncMaskCanvas}
            />
            <canvas
              ref={canvasRef}
              className={`image-edit-mask-canvas${maskEnabled ? " image-edit-mask-canvas-active" : ""}`}
              onPointerDown={handleMaskPointerDown}
              onPointerMove={handleMaskPointerMove}
              onPointerUp={handleMaskPointerEnd}
              onPointerCancel={handleMaskPointerEnd}
            />
          </div>
          {maskSupported && (
            <div className="image-edit-mask-row">
              <label className="image-edit-mask-toggle">
                <input
                  type="checkbox"
                  checked={maskEnabled}
                  onChange={(event) => setMaskEnabled(event.target.checked)}
                />
                <span>局部修改</span>
              </label>
              <button
                type="button"
                className="image-edit-mask-clear"
                onClick={handleClearMask}
                disabled={!maskTouched}
              >
                清除圈选
              </button>
            </div>
          )}
          <textarea
            className={`image-edit-prompt${error ? " image-edit-prompt-error" : ""}`}
            value={suggestion}
            onChange={(event) => {
              setSuggestion(event.target.value);
              if (error) setError("");
            }}
            onPaste={handleReferenceImagePaste}
            onDragOver={handleReferenceImageDragOver}
            onDrop={handleReferenceImageDrop}
            placeholder="输入修改建议"
            rows={3}
            autoFocus
          />
          <div className="image-edit-reference-row">
            <div className="image-edit-reference-title">参考图</div>
            <button
              type="button"
              className="image-edit-reference-add"
              onClick={() => referenceImageInputRef.current?.click()}
            >
              添加图片
            </button>
            <input
              ref={referenceImageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="image-edit-reference-input"
              onChange={handleReferenceImageSelect}
            />
          </div>
          {referenceImages.length > 0 && (
            <div className="image-edit-reference-images">
              {referenceImages.map(item => (
                <div key={item.id} className="chat-input-image-item image-edit-reference-item">
                  <img src={item.dataUrl} alt={item.fileName || "参考图"} />
                  <button
                    type="button"
                    className="chat-input-image-remove"
                    onClick={() => removeReferenceImage(item.id)}
                    aria-label="删除参考图"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <div className="image-edit-error">{error}</div>}
          <div className="image-edit-actions">
            <Button className="!text-xs" onPress={onCancel}>取消</Button>
            <Button
              className="!text-xs"
              onPress={handleConfirm}
              isDisabled={disabled || referenceImagesLoading}
            >
              {referenceImagesLoading ? "处理中..." : "确认"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

