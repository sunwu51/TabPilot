/* eslint-disable react/prop-types */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Switch } from "@sunwu51/camel-ui";
import { isImageFile, getClipboardImageFiles, imageFileToAttachmentItem } from "../messages/userMessage";
import { useLocalizedDom } from "../../../../i18n";

const IMAGE_EDIT_MODE = {
  ANNOTATION: "annotation",
  MASK: "mask"
};

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

export function ImageEditDialog({ request, disabled = false, onCancel, onConfirm }) {
  const rootRef = useLocalizedDom();
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState("");
  const [editMode, setEditMode] = useState(IMAGE_EDIT_MODE.ANNOTATION);
  const [maskTouched, setMaskTouched] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationCount, setAnnotationCount] = useState(0);
  const [referenceImages, setReferenceImages] = useState([]);
  const [referenceImagesLoading, setReferenceImagesLoading] = useState(false);
  const [imageBox, setImageBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const imageLayerRef = useRef(null);
  const imageRef = useRef(null);
  const canvasRef = useRef(null);
  const annotationInputRef = useRef(null);
  const referenceImageInputRef = useRef(null);
  const drawingRef = useRef(false);
  const maskPathsRef = useRef([]);
  const activeMaskPathRef = useRef([]);
  const pendingReferenceImageBatchesRef = useRef(0);
  const maskSupported = request?.maskSupported !== false;
  const isMaskMode = maskSupported && editMode === IMAGE_EDIT_MODE.MASK;
  const isAnnotationMode = editMode === IMAGE_EDIT_MODE.ANNOTATION;

  useEffect(() => {
    setSuggestion("");
    setError("");
    setEditMode(IMAGE_EDIT_MODE.ANNOTATION);
    setMaskTouched(false);
    setAnnotationDraft(null);
    setAnnotations([]);
    setAnnotationCount(0);
    setReferenceImages([]);
    setReferenceImagesLoading(false);
    setImageBox({ left: 0, top: 0, width: 0, height: 0 });
    drawingRef.current = false;
    maskPathsRef.current = [];
    activeMaskPathRef.current = [];
    pendingReferenceImageBatchesRef.current = 0;
    clearMaskCanvas();
  }, [request?.src]);

  useEffect(() => {
    if (maskSupported) return;
    setEditMode(IMAGE_EDIT_MODE.ANNOTATION);
    setMaskTouched(false);
    maskPathsRef.current = [];
    activeMaskPathRef.current = [];
    drawingRef.current = false;
    clearMaskCanvas();
  }, [maskSupported]);

  useEffect(() => {
    if (!annotationDraft) return;
    annotationInputRef.current?.focus();
  }, [annotationDraft]);

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

  const renderMaskPreview = useCallback(() => {
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
  }, []);

  const syncMaskCanvas = useCallback((event) => {
    const image = event?.currentTarget || imageRef.current;
    const imageLayer = imageLayerRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;
    const width = Math.max(1, image.naturalWidth || image.clientWidth || 1);
    const height = Math.max(1, image.naturalHeight || image.clientHeight || 1);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (imageLayer) {
      const imageRect = image.getBoundingClientRect();
      const layerRect = imageLayer.getBoundingClientRect();
      setImageBox({
        left: imageRect.left - layerRect.left,
        top: imageRect.top - layerRect.top,
        width: imageRect.width,
        height: imageRect.height
      });
    }
    renderMaskPreview();
  }, [renderMaskPreview]);

  useEffect(() => {
    const image = imageRef.current;
    const imageLayer = imageLayerRef.current;
    if (!image || !imageLayer || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => syncMaskCanvas());
    observer.observe(image);
    observer.observe(imageLayer);
    return () => observer.disconnect();
  }, [request?.src, syncMaskCanvas]);

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

  function handleModeChange(nextIsMaskMode) {
    const nextMode = nextIsMaskMode && maskSupported ? IMAGE_EDIT_MODE.MASK : IMAGE_EDIT_MODE.ANNOTATION;
    setEditMode(nextMode);
    if (nextMode === IMAGE_EDIT_MODE.MASK) {
      setAnnotationDraft(null);
    } else {
      maskPathsRef.current = [];
      drawingRef.current = false;
      activeMaskPathRef.current = [];
      clearMaskCanvas();
      setMaskTouched(false);
    }
  }

  function getCanvasPoint(event) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return null;
    }
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function getImagePercentPoint(event) {
    const image = imageRef.current;
    const imageRect = image?.getBoundingClientRect();
    const layerRect = imageLayerRef.current?.getBoundingClientRect();
    const rect = imageRect?.width && imageRect?.height ? imageRect : layerRect;
    if (!rect.width || !rect.height) return null;
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return null;
    }
    const xPercent = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const yPercent = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    return { xPercent, yPercent };
  }

  function getImageOverlayStyle() {
    if (!imageBox.width || !imageBox.height) return undefined;
    return {
      left: `${imageBox.left}px`,
      top: `${imageBox.top}px`,
      width: `${imageBox.width}px`,
      height: `${imageBox.height}px`
    };
  }

  function getAnnotationPositionStyle(point) {
    if (!imageBox.width || !imageBox.height) {
      return {
        left: `${point.xPercent}%`,
        top: `${point.yPercent}%`
      };
    }
    return {
      left: `${imageBox.left + (imageBox.width * point.xPercent) / 100}px`,
      top: `${imageBox.top + (imageBox.height * point.yPercent) / 100}px`
    };
  }

  function handleAnnotationClick(event) {
    if (!isAnnotationMode || event.target.closest?.(".image-edit-annotation-editor")) return;
    event.preventDefault();
    const point = getImagePercentPoint(event);
    if (!point) return;
    setAnnotationDraft({
      ...point,
      text: ""
    });
  }

  function formatAnnotationSuggestion(draft, text, index) {
    return `${index}. (x: ${draft.xPercent.toFixed(1)}%, y: ${draft.yPercent.toFixed(1)}%) ${text.trim()}`;
  }

  function submitAnnotationDraft() {
    const draft = annotationDraft;
    const text = draft?.text?.trim();
    if (!draft || !text) return;
    const nextIndex = annotationCount + 1;
    const nextLine = formatAnnotationSuggestion(draft, text, nextIndex);
    setAnnotations(prev => [...prev, {
      id: `annotation_${Date.now()}_${nextIndex}`,
      index: nextIndex,
      xPercent: draft.xPercent,
      yPercent: draft.yPercent
    }]);
    setSuggestion(prev => {
      const trimmedEnd = prev.trimEnd();
      return trimmedEnd ? `${trimmedEnd}\n${nextLine}` : nextLine;
    });
    setAnnotationCount(nextIndex);
    setAnnotationDraft(null);
    if (error) setError("");
  }

  function handleAnnotationKeyDown(event) {
    if (event.key !== "Enter" || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    submitAnnotationDraft();
  }

  function handleMaskPointerDown(event) {
    if (!isMaskMode) return;
    event.preventDefault();
    const point = getCanvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    activeMaskPathRef.current = [point];
    renderMaskPreview();
  }

  function handleMaskPointerMove(event) {
    if (!isMaskMode || !drawingRef.current) return;
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
      maskDataUrl: isMaskMode && maskPathsRef.current.length > 0 ? exportMaskDataUrl() : "",
      referenceImages
    });
  }

  return (
    <div className="dialog-backdrop image-edit-backdrop" onClick={onCancel}>
      <div
        ref={rootRef}
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
            <div className="image-edit-preview-content">
              <div
                ref={imageLayerRef}
                className={`image-edit-image-layer${isAnnotationMode ? " image-edit-preview-annotation" : ""}`}
                onClick={handleAnnotationClick}
              >
                <img
                  ref={imageRef}
                  src={request?.src}
                  alt={request?.alt || "图片"}
                  onLoad={syncMaskCanvas}
                />
                <canvas
                  ref={canvasRef}
                  className={`image-edit-mask-canvas${isMaskMode ? " image-edit-mask-canvas-active" : ""}`}
                  style={getImageOverlayStyle()}
                  onPointerDown={handleMaskPointerDown}
                  onPointerMove={handleMaskPointerMove}
                  onPointerUp={handleMaskPointerEnd}
                  onPointerCancel={handleMaskPointerEnd}
                />
                {annotations.map(annotation => (
                  <span
                    key={annotation.id}
                    className="image-edit-annotation-number image-edit-annotation-persisted"
                    style={getAnnotationPositionStyle(annotation)}
                  >
                    {annotation.index}
                  </span>
                ))}
                {annotationDraft && (
                  <>
                    <span
                      className="image-edit-annotation-number image-edit-annotation-draft-number"
                      style={getAnnotationPositionStyle(annotationDraft)}
                    >
                      {annotationCount + 1}
                    </span>
                    <div
                      className="image-edit-annotation-editor"
                      style={getAnnotationPositionStyle(annotationDraft)}
                    >
                      <div className="image-edit-annotation-input-wrap">
                        <input
                          ref={annotationInputRef}
                          value={annotationDraft.text}
                          onChange={(event) => setAnnotationDraft(prev => prev ? { ...prev, text: event.target.value } : prev)}
                          onKeyDown={handleAnnotationKeyDown}
                          placeholder="描述更改，回车发送"
                        />
                        <button
                          type="button"
                          className="image-edit-annotation-close"
                          onClick={() => setAnnotationDraft(null)}
                          aria-label="取消标注"
                          title="取消标注"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          {maskSupported && (
            <div className="image-edit-mask-row">
              <div className="image-edit-mode-switch">
                <span className={!isMaskMode ? "image-edit-mode-label-active" : ""}>标注模式</span>
                <Switch
                  isSelected={isMaskMode}
                  onChange={handleModeChange}
                  round
                  aria-label={isMaskMode ? "切换到标注模式" : "切换到蒙版模式"}
                  className="image-edit-mask-toggle"
                  style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}
                >
                  <span className={isMaskMode ? "image-edit-mode-label-active" : ""}>蒙版模式</span>
                </Switch>
              </div>
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
