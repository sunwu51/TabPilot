<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:6D5DFB,50:20C6FF,100:00E5A8&height=260&section=header&text=TabPilot&fontSize=76&fontColor=FFFFFF&fontAlignY=38&desc=Your%20AI%20copilot%20for%20a%20calmer%20browser&descAlignY=58&animation=fadeIn" alt="TabPilot banner" width="100%" />
</p>

<p align="center">
  <strong>Turn tab chaos into a focused workspace — then let AI do the browser work.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec">Chrome Web Store</a>
  · <a href="#features">Features</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="README.zh-CN.md">中文版</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/AI-Powered-8B5CF6" alt="AI powered" />
  <img src="https://img.shields.io/badge/MCP-Ready-00B894" alt="MCP ready" />
</p>

## One sidebar. Less tab switching. More flow.

TabPilot is an AI-powered Chrome side panel for people who live in their browser. Put a browser-aware agent to work on the page in front of you, then find pages instantly, reshape crowded windows into meaningful groups, and save research sessions for later.

It combines practical tab management with browser-aware AI tools — without making you leave the tab you are already in.

## Features

| | What it does |
| --- | --- |
| ✨ **Your browser-aware AI Agent** | Ask AI to work with tabs, windows, groups, history, page DOM actions, screenshots, and page-side evaluation — all from the side panel. |
| 🔌 **An agent that grows with you** | Connect HTTP or Chrome-extension MCP tools; optionally expose TabPilot's tools through a WebSocket bridge. |
| ⏱️ **Turn repeat work into automation** | Record and replay macros, keep agent conversations, export them, and schedule tool-driven tasks. |
| 🔎 **Find anything** | Search open tabs by title or URL and surface relevant browser history when the page is no longer open. |
| 🗂️ **Make order fast** | Group tabs by domain or your own rules, collapse groups, and move through busy windows without losing context. |
| 🧠 **Save your context** | Save workspaces and stashes, then restore them later while avoiding duplicate tabs. |
| ☁️ **Keep settings portable** | Export/import settings and sync settings or stashes to a GitHub repository. |

## Screenshots

> Add the following images under `docs/screenshots/` when they are ready. Keeping the filenames below lets this README render automatically.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/tab-overview.png" alt="TabPilot tab overview — open tabs, search, and grouped workspaces" /></td>
    <td width="50%"><img src="docs/screenshots/ai-agent.png" alt="TabPilot AI Agent — a browser-aware conversation with tools" /></td>
  </tr>
  <tr>
    <td align="center"><strong>1. Tab overview</strong><br />Show search results, several tab groups, and workspace controls.</td>
    <td align="center"><strong>2. AI Agent</strong><br />Show a real prompt plus tool calls/results, ideally with the current page context visible.</td>
  </tr>
</table>

## Quick start

1. Install TabPilot from the [Chrome Web Store](https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec).
2. Open the side panel and start with search, grouping, or a saved workspace.
3. Add an LLM provider in Settings to unlock the AI Agent.
4. Connect MCP tools when you want the agent to reach beyond the built-in browser toolkit.

## Build from source

```bash
npm install
npm run build
```

Load the generated `dist/` folder from `chrome://extensions` with **Developer mode** enabled.
