const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { initDatabase, ingestBrainstorm, retrieveSimilar, clearMemory } = require('./src/database.cjs');
const { createRagSession, streamRagResponse } = require('./src/llm.cjs');

let mainWindow = null;
let vramIntervalId = null;

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
    if (process.env.LTM_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  });
  mainWindow.on('closed', () => {
    if (vramIntervalId) clearInterval(vramIntervalId);
    vramIntervalId = null;
    mainWindow = null;
  });

  async function fetchVramStats() {
    try {
      const out = await new Promise((resolve, reject) => {
        exec('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const nums = out.trim().split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
      if (nums.length >= 2 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status:vram', { usedMB: nums[0], totalMB: nums[1] });
      }
    } catch {
      try {
        const si = require('systeminformation');
        const gfx = await si.graphics();
        const ctrl = gfx.controllers?.[0];
        if (ctrl?.vram && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('status:vram', { usedMB: ctrl.memoryUsed ?? 0, totalMB: ctrl.vram });
        }
      } catch {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('status:vram', { usedMB: null, totalMB: null });
        }
      }
    }
  }
  vramIntervalId = setInterval(fetchVramStats, 2000);
  fetchVramStats();
}

const DEFAULT_ANALYTICAL_CONTENT = `You are a local AI assistant with no default name. Adopt the identity provided in the conversation logs. Use the current persona name if one exists.
CRITICAL: Never prefix your response with your name, "Assistant:", or "Insight:". Start your response directly with dialogue or actions.`;

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
      .filter(f => !f.isDirectory() && f.name.toLowerCase().endsWith('.gguf') && !f.name.toLowerCase().includes('mmproj'))
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
ipcMain.handle('brainstorm:stream-rag', async (event, { prompt, image }) => {
  console.log('[Main] brainstorm:stream-rag received', { promptLength: prompt?.length, hasImage: !!image });
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    console.error('[Main] brainstorm:stream-rag: no window');
    return { success: false, error: 'No window' };
  }

  try {
    const promptPayload = { text: prompt, image: image ?? null };
    const finalText = await streamRagResponse('default', promptPayload, (chunk) => {
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
