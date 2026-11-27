// Hot reload for UI work: serves the renderer from Vite's dev server and runs Electron against it.
// Vue, CSS and store.ts changes apply live; main-process changes need a restart. `npm run dev`
// builds first, because the main process and the hidden transport page still load from dist/.
// Extra arguments go to Electron (`npm run dev -- --profile=alice`).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const electron = createRequire(import.meta.url)("electron");

const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.mts", import.meta.url)) });
await server.listen();
const url = server.resolvedUrls.local[0];
server.printUrls();

const child = spawn(electron, [".", `--dev-server=${url}`, ...process.argv.slice(2)], {
    cwd: desktopDir,
    stdio: "inherit",
});
child.on("exit", async (code) => {
    await server.close();
    process.exit(code ?? 0);
});
