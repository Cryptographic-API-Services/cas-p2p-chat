// Builds the renderer (Vue + Vuetify + Tailwind) into dist/src/renderer, next to the
// compiled main process, which loads it with BrowserWindow.loadFile.
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vuetify from "vite-plugin-vuetify";

export default defineConfig({
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    // Relative asset URLs, so the page works when loaded from file://.
    base: "./",
    plugins: [vue(), vuetify({ autoImport: true }), tailwindcss()],
    build: {
        outDir: fileURLToPath(new URL("./dist/src/renderer", import.meta.url)),
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
