import { chromeStorageVfs } from "../../../../utils/chromeStorageVfs";

export const MEMORY_INDEX_PATH = "/memory/index.json";
export const MEMORY_INDEX_VERSION = 1;
export const MEMORY_SEARCH_MIN_SCORE = 6;

const MEMORY_TYPES = new Set(["preference", "correction", "decision", "workflow", "entity", "reference"]);
const MAX_WRITE_RETRIES = 3;
const MAX_SEARCH_LIMIT = 10;

function cleanText(value, maxLength = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeText(value) {
  return cleanText(value, 10000)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function normalizeStringList(value, maxItems = 12) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = cleanText(item, 120);
    const normalized = normalizeText(text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeScope(scope) {
  const kind = cleanText(scope?.kind || "global", 40).toLowerCase();
  const value = kind === "global" ? "" : cleanText(scope?.value, 160);
  return { kind: kind || "global", value };
}

function emptyIndex() {
  return { version: MEMORY_INDEX_VERSION, items: [], updatedAt: Date.now() };
}

async function readIndexWithRevision() {
  try {
    const result = await chromeStorageVfs.readJsonWithStat(MEMORY_INDEX_PATH);
    const items = Array.isArray(result.value?.items) ? result.value.items : [];
    return { index: { version: MEMORY_INDEX_VERSION, items, updatedAt: Number(result.value?.updatedAt) || 0 }, revision: result.stat.revision };
  } catch (error) {
    if (error?.code === "ENOENT") return { index: emptyIndex(), revision: 0 };
    throw error;
  }
}

async function mutateIndex(mutator) {
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
    const { index, revision } = await readIndexWithRevision();
    const result = mutator(index);
    index.updatedAt = Date.now();
    try {
      await chromeStorageVfs.writeJson(MEMORY_INDEX_PATH, index, { expectedRevision: revision, expireAt: -1 });
      return result;
    } catch (error) {
      if (error?.code !== "ESTALE" || attempt === MAX_WRITE_RETRIES - 1) throw error;
    }
  }
}

function createMemoryId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function memoryKey(memory) {
  const scope = normalizeScope(memory.scope);
  return [scope.kind, normalizeText(scope.value), cleanText(memory.type, 40).toLowerCase(), normalizeText(memory.subject)].join("|");
}

function buildMemory(input, existing = null) {
  const now = Date.now();
  const type = cleanText(input.type || existing?.type, 40).toLowerCase();
  const subject = cleanText(input.subject || existing?.subject, 240);
  const summary = cleanText(input.summary ?? existing?.summary, 600);
  const content = cleanText(input.content ?? existing?.content, 6000);
  if (!MEMORY_TYPES.has(type)) throw new Error(`Unsupported memory type: ${type || "empty"}`);
  if (!subject) throw new Error("subject is required");
  if (!summary) throw new Error("summary is required");
  if (!content) throw new Error("content is required");
  return {
    id: existing?.id || createMemoryId(),
    type,
    subject,
    summary,
    content,
    keywords: normalizeStringList(input.keywords ?? existing?.keywords),
    entities: normalizeStringList(input.entities ?? existing?.entities),
    scope: normalizeScope(input.scope ?? existing?.scope),
    importance: Math.max(0, Math.min(1, Number(input.importance ?? existing?.importance ?? 0.5) || 0)),
    createdAt: Number(existing?.createdAt) || now,
    updatedAt: now,
    confirmationCount: Math.max(1, Number(existing?.confirmationCount) || 0) + (existing ? 1 : 0)
  };
}

function queryTerms(query) {
  return [...new Set(normalizeText(query).split(/\s+/).filter(term => term.length > 1 || /^\d+$/.test(term)))];
}

function chineseBigrams(value) {
  const result = new Set();
  for (const match of normalizeText(value).matchAll(/\p{Script=Han}+/gu)) {
    const text = match[0];
    if (text.length === 1) result.add(text);
    for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  }
  return result;
}

function diceCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function scopeMatches(memoryScope, requestedScope) {
  if (!requestedScope) return true;
  const left = normalizeScope(memoryScope);
  const right = normalizeScope(requestedScope);
  return left.kind === right.kind && normalizeText(left.value) === normalizeText(right.value);
}

export function scoreMemory(memory, query) {
  const normalizedQuery = normalizeText(query);
  const subject = normalizeText(memory.subject);
  const corpus = normalizeText([
    memory.subject,
    memory.summary,
    ...(memory.keywords || []),
    ...(memory.entities || [])
  ].join(" "));
  const terms = queryTerms(query);
  const matchedEntities = normalizeStringList(memory.entities).filter(entity => normalizedQuery.includes(normalizeText(entity)));
  const matchedEntityKeys = new Set(matchedEntities.map(entity => normalizeText(entity)));
  const matchedKeywords = normalizeStringList(memory.keywords).filter(keyword => {
    const normalized = normalizeText(keyword);
    return !matchedEntityKeys.has(normalized) && normalizedQuery.includes(normalized);
  });
  const coveredTerms = terms.filter(term => corpus.includes(term));
  const queryCoverage = terms.length ? coveredTerms.length / terms.length : 0;
  const bigramDice = diceCoefficient(chineseBigrams(query), chineseBigrams(`${memory.subject} ${memory.summary}`));
  const exactSubjectPhrase = subject && (normalizedQuery.includes(subject) || subject.includes(normalizedQuery)) ? 1 : 0;
  const distinctiveMatches = new Set([...matchedEntities, ...matchedKeywords].map(item => normalizeText(item))).size;
  const importance = Math.max(0, Math.min(1, Number(memory.importance) || 0));

  let score = exactSubjectPhrase * 12
    + matchedEntities.length * 8
    + matchedKeywords.length * 5
    + queryCoverage * 4
    + bigramDice * 2
    + importance;
  if (!matchedEntities.length && !matchedKeywords.length) score *= 0.35;
  if (distinctiveMatches >= 2) score += 5;

  return {
    score,
    signals: {
      exactSubjectPhrase: Boolean(exactSubjectPhrase),
      matchedEntities,
      matchedKeywords,
      queryCoverage,
      bigramDice,
      importance,
      distinctiveBonus: distinctiveMatches >= 2 ? 5 : 0,
      weakMatchPenalty: !matchedEntities.length && !matchedKeywords.length ? 0.35 : 1
    }
  };
}

export async function _execMemorySearch({ query, limit = 5, type, scope, minScore = MEMORY_SEARCH_MIN_SCORE } = {}) {
  const cleanedQuery = cleanText(query, 500);
  if (!cleanedQuery) return { error: "query is required" };
  const requestedType = cleanText(type, 40).toLowerCase();
  const safeLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(Number(limit) || 5)));
  const safeMinScore = Math.max(MEMORY_SEARCH_MIN_SCORE, Number(minScore) || MEMORY_SEARCH_MIN_SCORE);
  const { index } = await readIndexWithRevision();
  const matches = index.items
    .filter(memory => !requestedType || memory.type === requestedType)
    .filter(memory => scopeMatches(memory.scope, scope))
    .map(memory => ({ memory, ...scoreMemory(memory, cleanedQuery) }))
    .filter(result => result.score >= safeMinScore)
    .sort((a, b) => b.score - a.score || Number(b.memory.updatedAt) - Number(a.memory.updatedAt))
    .slice(0, safeLimit)
    .map(({ memory, score, signals }) => ({ ...memory, score: Number(score.toFixed(3)), matchedBy: signals }));
  return { success: true, query: cleanedQuery, minScore: safeMinScore, count: matches.length, memories: matches };
}

export async function _execMemorySave(input = {}) {
  return mutateIndex(index => {
    const draft = buildMemory(input);
    const key = memoryKey(draft);
    const existingIndex = index.items.findIndex(item => memoryKey(item) === key);
    const existing = existingIndex >= 0 ? index.items[existingIndex] : null;
    const memory = buildMemory(input, existing);
    if (existingIndex >= 0) index.items[existingIndex] = memory;
    else index.items.push(memory);
    return { success: true, action: existing ? "updated" : "created", memory };
  });
}

export async function _execMemoryUpdate({ id, ...patch } = {}) {
  const memoryId = cleanText(id, 120);
  if (!memoryId) return { error: "id is required" };
  return mutateIndex(index => {
    const itemIndex = index.items.findIndex(item => item.id === memoryId);
    if (itemIndex < 0) return { error: `Memory not found: ${memoryId}` };
    const memory = buildMemory(patch, index.items[itemIndex]);
    index.items[itemIndex] = memory;
    return { success: true, memory };
  });
}

export async function _execMemoryDelete({ id } = {}) {
  const memoryId = cleanText(id, 120);
  if (!memoryId) return { error: "id is required" };
  return mutateIndex(index => {
    const itemIndex = index.items.findIndex(item => item.id === memoryId);
    if (itemIndex < 0) return { success: true, id: memoryId, existed: false };
    index.items.splice(itemIndex, 1);
    return { success: true, id: memoryId, removed: true };
  });
}
