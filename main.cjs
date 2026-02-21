const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initDatabase, ingestBrainstorm, retrieveSimilar, clearMemory } = require('./src/database.cjs');
const { createRagSession, streamRagResponse } = require('./src/llm.cjs');

let mainWindow = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d1117',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.openDevTools();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  console.log('[Main] App ready');
  const dbPath = path.join(app.getPath('userData'), 'ltm-brainstorm.db');
  console.log('[Main] Initializing database', { dbPath });
  await initDatabase(dbPath);
  console.log('[Main] Database initialized, creating window');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Get app version from package.json
ipcMain.handle('brainstorm:get-app-version', () => {
  const { version } = require('./package.json');
  return version;
});

// IPC: Get default model path (project models dir)
ipcMain.handle('brainstorm:get-default-model-path', () => {
  return path.join(__dirname, 'models', 'gemma-2-2b-it-Q4_K_M.gguf');
});

// IPC: Ingest a brainstorm (save thought + embed + store)
ipcMain.handle('brainstorm:ingest', async (_, { text, projectTags }) => {
  console.log('[Main] brainstorm:ingest received', { textLength: text?.length, projectTags });
  try {
    const id = await ingestBrainstorm(text, projectTags || []);
    console.log('[Main] brainstorm:ingest success', { id });
    return { success: true, id };
  } catch (err) {
    console.error('Error in brainstorm:ingest:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Clear all LTM memory (wipe brainstorms + vec_brainstorms)
ipcMain.handle('brainstorm:clear', async () => {
  console.log('[Main] brainstorm:clear received');
  try {
    await clearMemory();
    console.log('[Main] brainstorm:clear success');
    return { success: true };
  } catch (err) {
    console.error('Error in brainstorm:clear:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Retrieve similar brainstorms (RAG context)
ipcMain.handle('brainstorm:retrieve', async (_, { query, limit }) => {
  console.log('[Main] brainstorm:retrieve received', { query, limit });
  try {
    const results = await retrieveSimilar(query, limit ?? 5);
    console.log('[Main] brainstorm:retrieve success', { resultCount: results?.length });
    return { success: true, results };
  } catch (err) {
    console.error('Error in brainstorm:retrieve:', err);
    return { success: false, error: err.message, results: [] };
  }
});

// IPC: Initialize RAG chat (load model)
ipcMain.handle('brainstorm:rag-chat', async (_, { modelPath }) => {
  console.log('[Main] brainstorm:rag-chat received', { modelPath });
  try {
    const session = await createRagSession(modelPath);
    if (!session) {
      console.log('[Main] brainstorm:rag-chat: session is null');
      return { success: false, error: 'LLM not initialized. Provide model path.' };
    }
    console.log('[Main] brainstorm:rag-chat success');
    return { success: true };
  } catch (err) {
    console.error('Error in brainstorm:rag-chat:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Stream RAG response (retrieve + LLM stream)
ipcMain.handle('brainstorm:stream-rag', async (event, { prompt }) => {
  console.log('[Main] brainstorm:stream-rag received', { promptLength: prompt?.length });
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    console.error('[Main] brainstorm:stream-rag: no window');
    return { success: false, error: 'No window' };
  }

  try {
    await streamRagResponse('default', prompt, (chunk) => {
      win.webContents.send('brainstorm:stream-chunk', { chunk });
    });
    win.webContents.send('brainstorm:stream-done', {});
    console.log('[Main] brainstorm:stream-rag completed');
    return { success: true };
  } catch (err) {
    console.error('Error in brainstorm:stream-rag:', err);
    win.webContents.send('brainstorm:stream-error', { error: err.message });
    return { success: false, error: err.message };
  }
});
