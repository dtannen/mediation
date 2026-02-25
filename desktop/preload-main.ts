import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadApi } from './preload';

contextBridge.exposeInMainWorld('mediationDesktop', createPreloadApi(ipcRenderer));
