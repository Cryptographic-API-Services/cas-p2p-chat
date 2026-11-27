// Builds the renderer (Vue + Vuetify + Tailwind) into dist/renderer, next to the
// compiled main process, which loads it with BrowserWindow.loadFile.
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vuetify from "vite-plugin-vuetify";

const DEV_PORT = 5173;

/** Dev server only (`npm run dev`): lets the page open Vite's hot-reload WebSocket. */
const allowHotReloadSocket: Plugin = {
    name: "cas-allow-hmr-socket",
    apply: "serve",
    transformIndexHtml: (html) =>
        html.replace("default-src 'none';", `default-src 'none'; connect-src ws://localhost:${DEV_PORT};`),
};

export default defineConfig({
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    // Relative asset URLs, so the page works when loaded from file://.
    base: "./",
    plugins: [vue(), vuetify({ autoImport: true }), tailwindcss(), allowHotReloadSocket],
    server: { host: "localhost", port: DEV_PORT, strictPort: true },
    build: {
        outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
        emptyOutDir: true,
        target: "chrome140",
        // Electron loads everything from disk: no need for the preload polyfill.
        modulePreload: { polyfill: false },
        rollupOptions: {
            input: {
                // The UI, and the hidden window that runs PeerJS (WebRTC) for the main process.
                index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
                transport: fileURLToPath(new URL("./src/renderer/transport.html", import.meta.url)),
            },
        },
    },
});
