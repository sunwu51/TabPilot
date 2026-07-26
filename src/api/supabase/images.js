import { loadSessionImageStore, recordSessionImageUpload } from "../agent/sessions";
import { getSupabasePath, loadSupabaseConfig, normalizePathPart } from "./config";
import { createSupabaseSignedUrl, dataUrlToBlob, mediaTypeExtension, uploadSupabaseObject } from "./storage";

export const SESSION_IMAGE_UPLOADED_EVENT = "tabmanager:session-image-uploaded";

export async function uploadSessionImage(sessionId, ref, source = "") {
  const normalizedSessionId = normalizePathPart(sessionId);
  const normalizedRef = normalizePathPart(ref);
  if (!normalizedSessionId || !/^img_[A-Za-z0-9_-]+$/.test(normalizedRef)) {
    throw new Error("图片缺少有效的 session 或 ref");
  }
  let dataUrl = String(source || "");
  if (!dataUrl.startsWith("data:image/")) {
    const imageStore = await loadSessionImageStore(sessionId);
    dataUrl = String(imageStore[ref] || "");
  }
  const blob = dataUrlToBlob(dataUrl);
  const config = await loadSupabaseConfig();
  const random = Math.random().toString(36).slice(2, 10);
  const fileName = `${normalizedRef}_${random}.${mediaTypeExtension(blob.type)}`;
  const path = getSupabasePath(config, "images", normalizedSessionId, fileName);
  const uploaded = await uploadSupabaseObject(path, blob, { config, contentType: blob.type, upsert: false });
  const url = await createSupabaseSignedUrl(uploaded.path, { config });
  const imageUpload = { ...uploaded, url };
  await recordSessionImageUpload(sessionId, ref, imageUpload);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_IMAGE_UPLOADED_EVENT, {
      detail: { sessionId, ref, uploadedUrl: url, uploadedPath: uploaded.path }
    }));
  }
  return imageUpload;
}

export async function refreshUploadedImageUrls(messages = []) {
  const config = await loadSupabaseConfig();
  return await Promise.all((Array.isArray(messages) ? messages : []).map(async message => {
    if (message?.role !== "user" || !Array.isArray(message.imageRefs)) return message;
    const imageRefs = await Promise.all(message.imageRefs.map(async image => {
      const uploadedPath = String(image?.uploadedPath || "").trim();
      if (!uploadedPath) return image;
      return { ...image, uploadedUrl: await createSupabaseSignedUrl(uploadedPath, { config }) };
    }));
    return { ...message, imageRefs };
  }));
}
