// Runs sandboxed, with context isolation: it can only reach the main process through the
// fixed set of IPC channels below, and the page can only reach it through `window.chat`.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api: ChatApi = {
    getSelf: () => ipcRenderer.invoke("chat:get-self"),
    listPeers: () => ipcRenderer.invoke("chat:list-peers"),
    listContacts: () => ipcRenderer.invoke("chat:list-contacts"),
    connect: (fingerprint) => ipcRenderer.invoke("chat:connect", fingerprint),
    sendText: (peerId, text) => ipcRenderer.invoke("chat:send-text", peerId, text),
    disconnect: (peerId) => ipcRenderer.invoke("chat:disconnect", peerId),
    loadHistory: (fingerprint) => ipcRenderer.invoke("chat:load-history", fingerprint),
    clearHistory: (fingerprint) => ipcRenderer.invoke("chat:clear-history", fingerprint),
    setVerified: (fingerprint, verified) => ipcRenderer.invoke("chat:set-verified", fingerprint, verified),
    setAvatar: (avatar) => ipcRenderer.invoke("chat:set-avatar", avatar),
    copyText: (text) => ipcRenderer.invoke("chat:copy-text", text),
    getServer: () => ipcRenderer.invoke("chat:get-server"),
    setServer: (url, listed) => ipcRenderer.invoke("chat:set-server", url, listed),
    setListed: (listed) => ipcRenderer.invoke("chat:set-listed", listed),
    searchDirectory: (query) => ipcRenderer.invoke("chat:search-directory", query),
    onEvent: (listener) => {
        const handler = (_event: IpcRendererEvent, payload: ApiEvent) => listener(payload);
        ipcRenderer.on("chat:event", handler);
        return () => {
            ipcRenderer.removeListener("chat:event", handler);
        };
    },
};

contextBridge.exposeInMainWorld("chat", api);
