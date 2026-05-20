import { normalizeMessageImageRefs } from "../../imageRefs";
export function findImageEditMcpTool(tools = []) {
  return (tools || []).find(tool => {
    const names = [tool?.name, tool?._toolCallName]
      .map(name => String(name || "").trim())
      .filter(Boolean);
    return names.some(name => name.replace(/-/g, "_").endsWith("image_edit"));
  }) || null;
}

export function getMcpToolCallName(tool) {
  const explicit = String(tool?._toolCallName || "").trim();
  if (explicit) return explicit;
  const serverName = String(tool?._serverName || "server").trim();
  const toolName = String(tool?.name || "image_edit").trim();
  return `mcp_${serverName}_${toolName}`;
}

export function buildImageEditUserPrompt({ toolCallName, imageRef, maskRef, additionalImageRefs = [], suggestion }) {
  const allImageRefs = [
    imageRef,
    ...(Array.isArray(additionalImageRefs) ? additionalImageRefs : [])
  ].filter(Boolean);
  const imagePlaceholders = allImageRefs.map(ref => `\`|deRef:${ref}|\``).join(", ");
  const lines = [
    `请使用工具 \`${toolCallName || "image_edit"}\` 修改这张图片。`,
    `原图 ref: ${imageRef}`,
    `调用工具时请把图片输入按这个顺序传入 images 数组: ${imagePlaceholders}。第一张是正在编辑的原图，后续图片是参考图。`
  ];

  if (maskRef) {
    lines.push(
      `局部修改 mask ref: ${maskRef}`,
      `mask 参数如果需要图片数据，请传入 \`|deRef:${maskRef}|\`。`,
      "mask 只对 images 数组第一张，也就是正在展示的原图生效；mask 是 PNG alpha mask：透明区域表示需要修改范围，不透明区域表示保持不变。请尽量只改 mask 透明区域。"
    );
  }

  if (allImageRefs.length === 1) {
    lines.push(`如果工具没有 images 参数，请传入 image 参数: \`|deRef:${imageRef}|\`。`);
  } else {
    const additionalPlaceholders = allImageRefs.slice(1).map(ref => `\`|deRef:${ref}|\``).join(", ");
    lines.push(
      `如果工具没有 images 参数，请传入 image 参数: \`|deRef:${imageRef}|\`，并传入 additional_images 数组: ${additionalPlaceholders}。`
    );
  }

  lines.push(`修改建议：${String(suggestion || "").trim()}`);
  return lines.join("\n");
}

export function buildImageEditMessageRefs({
  imageRef,
  imageSource,
  maskRef,
  maskSource,
  referenceRefs = [],
  referenceSources = []
}) {
  return normalizeMessageImageRefs([
    { ref: imageRef, dataUrl: imageSource, role: "edit_image" },
    ...referenceRefs.map((ref, index) => ({
      ref,
      dataUrl: referenceSources[index],
      role: "edit_reference"
    })),
    maskRef ? { ref: maskRef, dataUrl: maskSource, role: "edit_mask" } : null
  ]);
}
