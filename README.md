# Figure (Chrome Extension)

Figure is a minimal MV3 Chrome extension that uses the Gemini 3 Flash API to observe the visible tab and perform simple actions (click, type, scroll) in a short agent loop.

## Quick start

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder: `C:\Users\vansh\figure`.
4. Click the extension icon to open the popup.
5. Add your Gemini API key in the popup (or generate `config.js` from an env var), set the model name, and enter a task.
6. Click **Run**.

## Speed tips

- Set **Delay (ms)** to `0`–`100` for the fastest action loop (default is `0`).
- **Fast mode** is enabled by default to skip screenshots and reduce DOM scanning. Disable it if you want screenshot context.
- Keep **Max steps** low for quick tasks.

## API key from environment variable

Chrome extensions cannot read OS environment variables at runtime. To keep the key out of the popup, generate a local `config.js` file from an environment variable and reload the extension.

1. Set the env var (PowerShell):
```powershell
$env:GEMINI_API_KEY="YOUR_KEY"
```
2. Generate `config.js`:
```powershell
node scripts/generate-config.js
```
3. Reload the extension in `chrome://extensions`.

`config.js` is gitignored. You can use `config.example.js` as a template.

## Model selection

If you're unsure about the model string, you can list available models with the REST API:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY"
```

Use a Gemini 3 Flash model name returned in that list.

## What it does

- Captures a visible-tab screenshot and a compact list of interactive elements.
- Sends that context to Gemini with a structured-output schema.
- Executes the returned actions in the current tab.

## Limitations

- Only the visible tab and viewport are observed.
- Actions are best-effort and may fail on complex UIs.
- Avoid sensitive sites or irreversible actions.

## Files

- `manifest.json`: MV3 manifest and permissions.
- `background.js`: agent loop + Gemini API call.
- `content.js`: page state extraction + actions.
- `popup.html` / `popup.js` / `popup.css`: UI.
