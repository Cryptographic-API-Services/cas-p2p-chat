// Preload for the hidden WebRTC transport window: two fixed IPC channels, nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api: TransportApi = {
    onCommand: (listener) => {
        ipcRenderer.on("transport:command", (_event: IpcRendererEvent, command: TransportCommand) => listener(command));
    },
    emit: (event) => ipcRenderer.send("transport:event", event),
};

contextBridge.exposeInMainWorld("transport", api);
