const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ltm', {
  getAppVersion: () => ipcRenderer.invoke('brainstorm:get-app-version'),
  getDefaultModelPath: () =>
    ipcRenderer.invoke('brainstorm:get-default-model-path'),
  getModels: () => ipcRenderer.invoke('brainstorm:get-models'),
  getPersonas: () => ipcRenderer.invoke('brainstorm:get-personas'),
  readPersona: (filePath) => ipcRenderer.invoke('brainstorm:read-persona', filePath),

  ingest: (text, projectTags = []) =>
    ipcRenderer.invoke('brainstorm:ingest', { text, projectTags }),

  retrieve: (query, limit = 5) =>
    ipcRenderer.invoke('brainstorm:retrieve', { query, limit }),

  clearMemory: () => ipcRenderer.invoke('brainstorm:clear'),

  initRagChat: (modelPath, personaText) =>
    ipcRenderer.invoke('brainstorm:rag-chat', { modelPath, systemPrompt: personaText }),

  streamRag: (prompt) =>
    ipcRenderer.invoke('brainstorm:stream-rag', { prompt }),

  onStreamChunk: (callback) => {
    ipcRenderer.on('brainstorm:stream-chunk', (_, { chunk }) => callback(chunk));
  },

  onStreamDone: (callback) => {
    ipcRenderer.on('brainstorm:stream-done', callback);
  },

  onStreamError: (callback) => {
    ipcRenderer.on('brainstorm:stream-error', (_, { error }) => callback(error));
  },
});
