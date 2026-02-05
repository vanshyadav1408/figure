const fs = require("fs");
const path = require("path");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  console.error("Example (PowerShell): $env:GEMINI_API_KEY=\"YOUR_KEY\"");
  process.exit(1);
}

const safeKey = apiKey.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
const content = `export const GEMINI_API_KEY = "${safeKey}";\n`;

const target = path.join(__dirname, "..", "config.js");
fs.writeFileSync(target, content, "utf8");
console.log(`Wrote ${target}`);
