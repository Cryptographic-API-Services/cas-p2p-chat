// Some npm setups skip dependency install scripts, which leaves Electron without its binary.
// This runs Electron's own downloader if the binary is missing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join("node_modules", "electron");
const pathFile = join(dir, "path.txt");
if (existsSync(dir) && !(existsSync(pathFile) && existsSync(join(dir, "dist", readFileSync(pathFile, "utf8").trim())))) {
    console.log("Downloading the Electron binary…");
    execFileSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit" });
}
