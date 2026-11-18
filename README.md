# Shakti Browser

A fast, Chrome-style web browser with a built-in AI agent — for **Windows, macOS and Linux (Ubuntu, Debian, Fedora and more)**.

Shakti Browser runs on Chromium, the same engine as Google Chrome, so websites, logins, video, downloads and web apps work just like they do in Chrome. On top of that it has **Shakti AI**, an agent in a side panel that can read the page you are on, answer questions, search the web and carry out multi-step tasks for you.

## Download

Go to **[Releases](https://github.com/geniusbridgetech/shakti-browser/releases)** and pick the file for your computer:

| Your computer | File | How to install |
| :--- | :--- | :--- |
| **Windows 10/11** | `Shakti Browser Setup 1.0.0.exe` | Double-click and follow the installer |
| **macOS** (Apple Silicon or Intel) | `Shakti Browser-1.0.0-arm64.dmg` / `Shakti Browser-1.0.0.dmg` | Open the `.dmg`, drag Shakti Browser to Applications |
| **Ubuntu / Debian** | `shakti-browser_1.0.0_amd64.deb` | `sudo apt install ./shakti-browser_1.0.0_amd64.deb` |
| **Fedora / RHEL / openSUSE** | `shakti-browser-1.0.0.x86_64.rpm` | `sudo dnf install ./shakti-browser-1.0.0.x86_64.rpm` |
| **Any Linux** | `Shakti Browser-1.0.0.AppImage` | `chmod +x` the file, then double-click it |

> The builds are not code-signed yet. On Windows, click **More info → Run anyway** if SmartScreen warns. On macOS, right-click the app and choose **Open** the first time.

## Features

- **Looks and works like Chrome** — tab strip in the title bar, drag to reorder tabs, address bar with suggestions, bookmarks bar, new-tab page with shortcuts, light and dark themes.
- **Everything you expect from a browser** — history, bookmarks, downloads, find in page, zoom, print, save page, developer tools, page context menus, permission prompts for camera/microphone/location, pop-ups open as tabs.
- **Incognito windows** — nothing is saved; cookies and site data are deleted when the window closes.
- **Chrome keyboard shortcuts** — `Ctrl/⌘+T`, `W`, `Shift+T`, `N`, `Shift+N`, `L`, `F`, `D`, `H` (`⌘Y` on Mac), `J`, `+`/`-`/`0`, `Ctrl+Tab`, `Alt+←/→` (`⌘[`/`⌘]` on Mac), `F5`, `F11`, `F12`.
- **Native on every OS** — macOS traffic-light buttons, Windows/Linux window controls, installers for each platform, opens links from other apps.

## Shakti AI agent

Open it with the **Shakti AI** button or `Ctrl/⌘+E`. Try:

- *Summarize this page*
- *What are the key points on this page?*
- *Search for the latest ISRO missions and summarize the top result*
- *Open wikipedia.org and find the article on NavIC*

**Full agent (Claude):** open **⋮ → Settings → Shakti AI** and paste a Claude API key from [console.anthropic.com](https://console.anthropic.com). The key is stored on your computer, encrypted with the system keychain where available, and only the main process uses it — web pages never see it. The agent uses `claude-opus-5-5` and can read pages, open sites, search, click, type, scroll and manage tabs. Clicks and typing are sent as real input, so the agent works on modern sites.

**Offline agent:** without a key, a built-in agent runs entirely on your computer and understands commands like *open isro.gov.in*, *search RISC-V news*, *summarize this page*, *find "admission" on this page*, *list tabs*, *go back*.

**Safety:** text on web pages is treated as information, never as instructions. The agent refuses to type into password, payment or one-time-code fields, never completes purchases, and asks before sending anything for you.

**Privacy:** with the Claude agent turned on, your request and the text of pages the agent reads are sent to the Claude API. The offline agent sends nothing.

## Build it yourself

You need [Node.js](https://nodejs.org) **22.12 or newer** (the current LTS works). Check with `node -v`.

```bash
git clone https://github.com/geniusbridgetech/shakti-browser.git
cd shakti-browser
npm install
npm start               # run the browser
```

Make installers for your current computer:

```bash
npm run dist:win        # on Windows → dist/*.exe
npm run dist:mac        # on macOS   → dist/*.dmg
npm run dist:linux      # on Linux   → dist/*.AppImage, *.deb, *.rpm
```

Or push a tag and GitHub Actions builds all three platforms and attaches the installers to a release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Project layout

| Path | What it is |
| :--- | :--- |
| `src/main/main.js` | Windows, tabs security, shortcuts, menus, downloads, permissions |
| `src/main/agent.js` | Claude connection (API key storage, model, tools) |
| `src/main/page-tools.js` | How the agent reads pages and clicks/types (isolated from page scripts) |
| `src/preload/preload.js` | The small API the browser UI may use |
| `src/renderer/` | Browser UI: tabs, address bar, new-tab and settings pages, AI panel |
| `electron-builder.yml` | Installer settings for Windows, macOS and Linux |
| `.github/workflows/build.yml` | Automatic builds for all platforms |

Set `SHAKTI_AGENT_MODEL` to use a different Claude model.
