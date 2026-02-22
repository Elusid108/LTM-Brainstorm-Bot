const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
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

const DEFAULT_ANALYTICAL_CONTENT = `You are a highly analytical, local AI assistant.
CRITICAL RULES & IDENTITY BOUNDARIES:

YOUR IDENTITY: You start with no default name. Look at the retrieved Long-Term Memory (LTM) logs. If the Human has assigned you a name, adopt the most recent one. If they ask what they used to call you, reference older names in the logs.

SEPARATION OF ENTITIES: The memories provided belong to the Human, not you. NEVER claim the Human's memories, physical belongings, pets, family, or life experiences as your own. You are the AI. They are the Human.

THIRD PARTIES: If the context mentions other people or places, treat them strictly as external subjects.

TONE: Be concise and technical. NEVER use emojis under any circumstances.`;

app.whenReady().then(async () => {
  console.log('[Main] App ready');
  const personasDir = path.join(__dirname, 'personas');
  if (!fs.existsSync(personasDir)) fs.mkdirSync(personasDir, { recursive: true });
  const analyticalPath = path.join(personasDir, 'Analytical.txt');
  if (!fs.existsSync(analyticalPath)) {
    fs.writeFileSync(analyticalPath, DEFAULT_ANALYTICAL_CONTENT.trim(), 'utf-8');
    console.log('[Main] Created default persona: Analytical.txt');
  }
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

// IPC: Get list of .txt persona files from local personas directory
ipcMain.handle('brainstorm:get-personas', () => {
  const personasDir = path.join(__dirname, 'personas');
  try {
    const files = fs.readdirSync(personasDir, { withFileTypes: true });
    return files
      .filter(f => !f.isDirectory() && f.name.endsWith('.txt'))
      .map(f => ({ name: f.name.replace('.txt', ''), path: path.join(personasDir, f.name) }));
  } catch (err) {
    console.error('[Main] brainstorm:get-personas:', err);
    return [];
  }
});

// IPC: Read persona file contents
ipcMain.handle('brainstorm:read-persona', (_, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

// IPC: Get list of .gguf models from local models directory
ipcMain.handle('brainstorm:get-models', () => {
  const modelsDir = path.join(__dirname, 'models');
  try {
    const files = fs.readdirSync(modelsDir, { withFileTypes: true });
    return files
      .filter(f => !f.isDirectory() && f.name.endsWith('.gguf'))
      .map(f => ({ name: f.name, path: path.join(modelsDir, f.name) }));
  } catch (err) {
    console.error('[Main] brainstorm:get-models:', err);
    return [];
  }
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

// IPC: Initialize RAG chat (load model + system prompt from persona)
ipcMain.handle('brainstorm:rag-chat', async (_, { modelPath, systemPrompt }) => {
  console.log('[Main] brainstorm:rag-chat received', { modelPath, systemPromptLength: systemPrompt?.length });
  try {
    console.log('[Main] Attempting to load model path:', modelPath);
    const session = await createRagSession(modelPath, systemPrompt ?? '');
    if (!session) {
      console.log('[Main] brainstorm:rag-chat: session is null');
      return { success: false, error: 'LLM not initialized. Provide model path.' };
    }
    console.log('[Main] brainstorm:rag-chat success');
    return { success: true };
  } catch (err) {
    console.error('[Main] Model initialization crashed:', err);
    throw err;
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
    const finalText = await streamRagResponse('default', prompt, (chunk) => {
      win.webContents.send('brainstorm:stream-chunk', { chunk });
    });
    win.webContents.send('brainstorm:stream-done', { finalText: finalText ?? '' });
    console.log('[Main] brainstorm:stream-rag completed');
    return { success: true };
  } catch (err) {
    console.error('Error in brainstorm:stream-rag:', err);
    win.webContents.send('brainstorm:stream-error', { error: err.message });
    return { success: false, error: err.message };
  }
});
