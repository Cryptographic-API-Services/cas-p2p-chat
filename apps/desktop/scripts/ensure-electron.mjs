// Some npm setups skip dependency install scripts, which leaves Electron without its binary.
// This runs Electron's own downloader if the binary is missing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let dir;
try {
    // Electron may be hoisted to the repository root's node_modules.
    dir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
} catch {
    process.exit(0);
}
const pathFile = join(dir, "path.txt");
if (!(existsSync(pathFile) && existsSync(join(dir, "dist", readFileSync(pathFile, "utf8").trim())))) {
    console.log("Downloading the Electron binary…");
    execFileSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit" });
}
