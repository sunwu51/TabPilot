import { encodeCompressedJson, decodeCompressedJson } from "./codec";

const GITHUB_API_BASE = "https://api.github.com";

export async function getGithubSyncFile(config, path) {
  const url = buildContentsUrl(config, path);
  const response = await fetch(url, {
    method: "GET",
    headers: buildGithubHeaders(config)
  });
  if (response.status === 404) return null;
  const body = await readGithubResponse(response);
  return {
    sha: body.sha,
    content: decodeCompressedJson(body.content || "")
  };
}

export async function getGithubSyncFileLenient(config, path) {
  const response = await fetch(buildContentsUrl(config, path), {
    method: "GET",
    headers: buildGithubHeaders(config)
  });
  if (response.status === 404) return null;
  const body = await readGithubResponse(response);
  try {
    return {
      sha: body.sha,
      content: decodeCompressedJson(body.content || ""),
      unreadable: false
    };
  } catch (error) {
    return {
      sha: body.sha,
      content: null,
      unreadable: true,
      error: error?.message || String(error)
    };
  }
}

export async function getGithubSyncFileSha(config, path) {
  const response = await fetch(buildContentsUrl(config, path), {
    method: "GET",
    headers: buildGithubHeaders(config)
  });
  if (response.status === 404) return "";
  const body = await readGithubResponse(response);
  return String(body?.sha || "");
}

export async function putGithubSyncFile(config, path, value, { sha = "" } = {}) {
  const body = {
    message: `Sync TabManager ${path}`,
    content: encodeCompressedJson(value)
  };
  if (sha) body.sha = sha;
  if (config.branch) body.branch = config.branch;

  const response = await fetch(buildContentsUrl(config, path), {
    method: "PUT",
    headers: {
      ...buildGithubHeaders(config),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  let payload;
  try {
    payload = await readGithubResponse(response);
  } catch (error) {
    if (shouldRetryMissingSha(error, sha)) {
      const existingSha = await getGithubSyncFileSha(config, path);
      if (existingSha) return await putGithubSyncFile(config, path, value, { sha: existingSha });
    }
    throw error;
  }
  return {
    sha: payload?.content?.sha || payload?.sha || "",
    commitSha: payload?.commit?.sha || ""
  };
}

function buildContentsUrl(config, path) {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const encodedPath = String(path || "")
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
  const url = new URL(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`);
  if (config.branch) url.searchParams.set("ref", config.branch);
  return url.toString();
}

function buildGithubHeaders(config) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${config.token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function readGithubResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function shouldRetryMissingSha(error, sha) {
  if (sha || !error?.status) return false;
  const message = String(error?.body?.message || error?.message || "").toLowerCase();
  return message.includes("sha") && (message.includes("wasn't supplied") || message.includes("not supplied"));
}
