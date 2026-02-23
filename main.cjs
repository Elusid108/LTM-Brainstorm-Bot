const { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { initDatabase, ingestBrainstorm, retrieveSimilar, clearMemory, savePersonaSettings, getPersonaSettings, cleanOrphanedPersonas } = require('./src/database.cjs');
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
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    // 1. Spelling suggestions
    for (const suggestion of params.dictionarySuggestions || []) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => mainWindow.webContents.replaceMisspelling(suggestion)
      }));
    }

    // 2. Add to Dictionary (when a misspelled word is present)
    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: 'Add to Dictionary',
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // 3. Edit commands
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow });
    }
  });
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

  const validPersonaNames = fs.readdirSync(personasDir, { withFileTypes: true })
    .filter((f) => !f.isDirectory() && f.name.endsWith('.txt'))
    .map((f) => f.name.replace('.txt', ''));
  await cleanOrphanedPersonas(validPersonaNames);

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

// IPC: Get default model name (Ollama)
ipcMain.handle('brainstorm:get-default-model-path', () => {
  return 'llama3.2';
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

// Strip ChatML/Llama tags from persona text; return raw prose only
function stripPersonaTags(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<\|im_start\|>[\w]*\n?/g, '')
    .replace(/<\|im_end\|>\n?/g, '')
    .replace(/\[Llama\]\s*/gi, '')
    .replace(/\s{2,}/g, '\n')
    .trim();
}

// IPC: Read persona file contents (prose only, tags stripped)
ipcMain.handle('brainstorm:read-persona', (_, filePath) => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return stripPersonaTags(raw);
});

// IPC: Save persona settings (model, isolate, context_length, thinking per persona)
ipcMain.handle('brainstorm:save-persona-settings', async (_, { name, model, isolate, context_length, thinking }) => {
  try {
    await savePersonaSettings(name, model, isolate, context_length, thinking);
    return { success: true };
  } catch (err) {
    console.error('[Main] brainstorm:save-persona-settings:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Get persona settings (returns default if none saved)
ipcMain.handle('brainstorm:get-persona-settings', async (_, { name }) => {
  const row = await getPersonaSettings(name);
  return row || { model: 'qwen2.5-vl:latest', isolate: 1, context_length: 8192, thinking: 0 };
});

// IPC: Get list of models from Ollama API
ipcMain.handle('brainstorm:get-models', async () => {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    const data = await response.json();
    return (data.models || []).map(m => ({ name: m.name, path: m.name }));
  } catch (err) {
    console.warn('[Main] Ollama not reachable:', err.message);
    return [];
  }
});

// IPC: Ingest a brainstorm (save thought + embed + store)
ipcMain.handle('brainstorm:ingest', async (_, { text, projectTags, persona }) => {
  console.log('[Main] brainstorm:ingest received', { textLength: text?.length, projectTags, persona });
  try {
    const id = await ingestBrainstorm(text, projectTags || [], persona ?? 'Global');
    console.log('[Main] brainstorm:ingest success', { id });
    return { success: true, id };
  } catch (err) {
    console.error('Error in brainstorm:ingest:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Clear all LTM memory (wipe brainstorms + vec_brainstorms)
ipcMain.handle('brainstorm:clear', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Yes, Wipe Memory'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm Memory Wipe',
    message: 'Are you sure you want to clear the Long-Term Memory?',
    detail: 'This will permanently delete all stored memories for this persona (or global context). This cannot be undone.'
  });
  if (response !== 1) {
    return { success: false };
  }
  try {
    await clearMemory();
    console.log('[Main] brainstorm:clear success');
    return { success: true };
  } catch (err) {
    console.error('Error in brainstorm:clear:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Cleanup orphaned data (personas that no longer exist in /personas folder)
ipcMain.handle('brainstorm:cleanup-orphaned-data', async () => {
  try {
    const personasDir = path.join(__dirname, 'personas');
    const validPersonaNames = fs.existsSync(personasDir)
      ? fs.readdirSync(personasDir, { withFileTypes: true })
          .filter((f) => !f.isDirectory() && f.name.endsWith('.txt'))
          .map((f) => f.name.replace('.txt', ''))
      : [];
    await cleanOrphanedPersonas(validPersonaNames);
    console.log('[Main] brainstorm:cleanup-orphaned-data success');
    return { success: true };
  } catch (err) {
    console.error('[Main] brainstorm:cleanup-orphaned-data:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Retrieve similar brainstorms (RAG context)
ipcMain.handle('brainstorm:retrieve', async (_, { query, limit, persona, isolate }) => {
  console.log('[Main] brainstorm:retrieve received', { query, limit, persona, isolate });
  try {
    const results = await retrieveSimilar(query, limit ?? 5, { persona, isolate });
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
ipcMain.handle('brainstorm:stream-rag', async (event, { prompt, image, chatHistory, persona, isolate, contextLength, thinkingMode }) => {
  console.log('[Main] brainstorm:stream-rag received', { promptLength: prompt?.length, hasImage: !!image, chatHistoryLen: chatHistory?.length, persona, isolate, contextLength, thinkingMode });
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    console.error('[Main] brainstorm:stream-rag: no window');
    return { success: false, error: 'No window' };
  }

  try {
    const promptPayload = { text: prompt, image: image ?? null, chatHistory: chatHistory ?? [], persona: persona ?? 'Global', isolate: isolate ?? false, contextLength: contextLength ?? 8192, thinkingMode: thinkingMode ?? false };
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
