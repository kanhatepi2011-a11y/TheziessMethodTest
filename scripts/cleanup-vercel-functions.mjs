import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(scriptDir, "..");
const apiDir = join(projectRoot, "api");
const legacyServerApiDir = join(projectRoot, "server", "api");
const keepFile = "[...route].js";

if (!existsSync(apiDir)) {
  throw new Error(`Missing API directory: ${apiDir}`);
}

for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name === keepFile) continue;
  rmSync(join(apiDir, entry.name), { recursive: true, force: true });
  console.log(`Removed legacy API entry: api/${entry.name}`);
}

if (existsSync(legacyServerApiDir)) {
  rmSync(legacyServerApiDir, { recursive: true, force: true });
  console.log("Removed legacy handler tree: server/api");
}

const remaining = readdirSync(apiDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:js|mjs|cjs|ts)$/.test(entry.name))
  .map((entry) => entry.name);

if (remaining.length !== 1 || remaining[0] !== keepFile) {
  throw new Error(
    `Expected only api/${keepFile}, found: ${remaining.map((name) => basename(name)).join(", ") || "none"}`,
  );
}

console.log(`Vercel Function cleanup complete. Entrypoints: ${remaining.length}`);
