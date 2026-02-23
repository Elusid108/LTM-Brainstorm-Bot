const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ltm', {
  getAppVersion: () => ipcRenderer.invoke('brainstorm:get-app-version'),
  getDefaultModelPath: () =>
    ipcRenderer.invoke('brainstorm:get-default-model-path'),
  getModels: () => ipcRenderer.invoke('brainstorm:get-models'),
  getPersonas: () => ipcRenderer.invoke('brainstorm:get-personas'),
  readPersona: (filePath) => ipcRenderer.invoke('brainstorm:read-persona', filePath),
  savePersonaSettings: (name, model, isolate) =>
    ipcRenderer.invoke('brainstorm:save-persona-settings', { name, model, isolate }),
  getPersonaSettings: (name) =>
    ipcRenderer.invoke('brainstorm:get-persona-settings', { name }),

  ingest: (text, projectTags = []) =>
    ipcRenderer.invoke('brainstorm:ingest', { text, projectTags }),

  retrieve: (query, limit = 5) =>
    ipcRenderer.invoke('brainstorm:retrieve', { query, limit }),

  clearMemory: () => ipcRenderer.invoke('brainstorm:clear'),

  initRagChat: (modelPath, personaText) =>
    ipcRenderer.invoke('brainstorm:rag-chat', { modelPath, systemPrompt: personaText }),

  streamRag: (prompt) =>
    ipcRenderer.invoke('brainstorm:stream-rag', { prompt }),
  streamRagResponse: (payload) =>
    ipcRenderer.invoke('brainstorm:stream-rag', {
      prompt: payload?.text ?? '',
      image: payload?.image ?? null,
      chatHistory: payload?.chatHistory ?? [],
      persona: payload?.persona ?? 'Global',
      isolate: payload?.isolate ?? false
    }),

  onStreamChunk: (callback) => {
    ipcRenderer.on('brainstorm:stream-chunk', (_, { chunk }) => callback(chunk));
  },

  onStreamDone: (callback) => {
    ipcRenderer.on('brainstorm:stream-done', (_, { finalText }) => callback(finalText ?? ''));
  },

  onStreamError: (callback) => {
    ipcRenderer.on('brainstorm:stream-error', (_, { error }) => callback(error));
  },

  onVramUpdate: (callback) => {
    ipcRenderer.on('status:vram', (_, stats) => callback(stats));
  },
});
