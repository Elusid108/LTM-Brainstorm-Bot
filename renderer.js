const output = document.getElementById('output');
const input = document.getElementById('input');
const btnChat = document.getElementById('btn-chat');
const statusEl = document.getElementById('status');
const modelStatusEl = document.getElementById('model-status');
const vramMonitorEl = document.getElementById('vram-monitor');
const typingIndicator = document.getElementById('typing-indicator');
const imagePreviewContainer = document.getElementById('image-preview-container');
const previewImg = document.getElementById('preview-img');
const removeImgBtn = document.getElementById('remove-img-btn');
const imageInput = document.getElementById('image-input');
const uploadImgBtn = document.getElementById('upload-img-btn');

let modelPath = null;
let currentBase64Image = null;
let pendingBuffer = '';
let isInitialLoading = false;
let chatHistory = [];

function getCurrentPersonaName() {
  const personaSelect = document.getElementById('persona-select');
  return personaSelect?.options[personaSelect.selectedIndex]?.text || 'Global';
}

/**
 * Parses a single paragraph into bubbles: splits by *action* blocks (preserving asterisks).
 * Action blocks get italic styling; dialogue gets character-name stripping.
 */
function processParagraph(text) {
  const subParts = text.split(/(\*[^*]+\*)/g).filter(part => part.trim() !== '');
  subParts.forEach(part => {
    let trimmedPart = part.trim();
    if (!trimmedPart) return;
    if (trimmedPart.startsWith('*') && trimmedPart.endsWith('*')) {
      appendLine(trimmedPart, 'assistant', true);
    } else {
      trimmedPart = trimmedPart.replace(/^[a-z\s.-]+:\s*/i, '').replace(/^"|"$/g, '').trim();
      if (trimmedPart) {
        appendLine(trimmedPart, 'assistant', false);
      }
    }
  });
}

// Block-style stream parsing: accumulate chunks, emit on \n\n
let hasReceivedFirstChunk = false;
window.ltm.onStreamChunk((chunk) => {
  if (typingIndicator) typingIndicator.style.display = '';
  if (!hasReceivedFirstChunk) {
    hasReceivedFirstChunk = true;
    btnChat.classList.remove('btn-processing');
    btnChat.textContent = 'Send';
  }
  pendingBuffer += chunk;
  if (pendingBuffer.includes('\n\n')) {
    const parts = pendingBuffer.split('\n\n');
    pendingBuffer = parts.pop();
    parts.forEach((p) => processParagraph(p));
  }
  output.scrollTop = output.scrollHeight;
});

window.ltm.onStreamDone((finalText) => {
  console.log('[Renderer] Stream completed');
  hasReceivedFirstChunk = false;
  if (typingIndicator) typingIndicator.style.display = 'none';
  if (pendingBuffer.trim()) {
    processParagraph(pendingBuffer.trim());
  }
  pendingBuffer = '';
  if (finalText) {
    chatHistory.push({ role: 'assistant', content: finalText });
  }
  setStatus('Idle');
  btnChat.classList.remove('btn-processing');
  btnChat.textContent = 'Send';
  btnChat.disabled = false;
  input.focus();
  output.scrollTop = output.scrollHeight;
});

window.ltm.onStreamError((err) => {
  console.error('[Renderer] Stream IPC error:', err);
  hasReceivedFirstChunk = false;
  if (typingIndicator) typingIndicator.style.display = 'none';
  pendingBuffer = '';
  appendLine(`Error: ${err}`, 'assistant');
  setStatus('Idle');
  btnChat.classList.remove('btn-processing');
  btnChat.textContent = 'Send';
  btnChat.disabled = false;
  input.focus();
});

async function initRagSession() {
  const modelSelect = document.getElementById('model-select');
  const personaSelect = document.getElementById('persona-select');
  const model = modelSelect?.value || modelPath;
  if (!model) return { success: false, error: 'No model path' };
  const personaPath = personaSelect?.value || '';
  let personaText = '';
  if (personaPath) {
    try {
      personaText = await window.ltm.readPersona(personaPath);
    } catch (e) {
      console.error('[Renderer] Failed to read persona:', e);
      modelStatusEl.textContent = `Persona: ${e.message}`;
      return { success: false, error: `Persona read failed: ${e.message}` };
    }
  }
  modelStatusEl.textContent = 'Loading...';
  try {
    const init = await window.ltm.initRagChat(model, personaText);
    if (init.success) {
      modelStatusEl.textContent = 'Model: Loaded';
    } else {
      modelStatusEl.textContent = `Model: Error - ${init.error}`;
    }
    return init;
  } catch (e) {
    modelStatusEl.textContent = `Model: Error - ${e.message}`;
    return { success: false, error: e.message };
  }
}

function updateUploadButtonState() {
  const modelSelect = document.getElementById('model-select');
  const uploadBtn = document.getElementById('upload-img-btn');
  if (!modelSelect || !uploadBtn) return;
  const filename = (modelSelect.value || '').toLowerCase();
  const isVision = filename.includes('vl') || filename.includes('vision');
  if (isVision) {
    uploadBtn.removeAttribute('disabled');
  } else {
    uploadBtn.setAttribute('disabled', '');
  }
}

/**
 * Appends a system inline notification (centered, italic).
 * @param {string} text - The notification text
 */
function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  if (typingIndicator && typingIndicator.parentNode === output) {
    output.insertBefore(el, typingIndicator);
  } else {
    output.appendChild(el);
  }
  output.scrollTop = output.scrollHeight;
}

/**
 * Appends a chat bubble to the output.
 * @param {string} content - The message text
 * @param {'user'|'assistant'|'system'|'ingest'} sender - Sender type
 * @param {boolean} isAction - If true, style as action block (italic, blue tint)
 * @returns {HTMLElement} The bubble element
 */
function appendLine(content, sender = 'system', isAction = false) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${sender}`;
  if (isAction) bubble.classList.add('action-block');
  const contentEl = document.createElement('div');
  contentEl.className = 'bubble-content';
  contentEl.textContent = content;
  bubble.appendChild(contentEl);

  if (sender === 'assistant') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
    bubble.appendChild(copyBtn);
  }

  if (typingIndicator && typingIndicator.parentNode === output) {
    output.insertBefore(bubble, typingIndicator);
  } else {
    output.appendChild(bubble);
  }
  output.scrollTop = output.scrollHeight;
  return bubble;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Set models dropdown, version, personas, and auto-init on load
window.addEventListener('DOMContentLoaded', async () => {
  const version = await window.ltm.getAppVersion();
  document.getElementById('version').textContent = `v${version}`;

  window.ltm.onVramUpdate((stats) => {
    if (vramMonitorEl) {
      if (stats?.usedMB != null && stats?.totalMB != null) {
        vramMonitorEl.textContent = `${stats.usedMB} / ${stats.totalMB} MB`;
      } else {
        vramMonitorEl.textContent = '— MB';
      }
    }
  });

  const models = await window.ltm.getModels();
  const modelSelect = document.getElementById('model-select');
  const personaSelect = document.getElementById('persona-select');

  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.path;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });

  const personas = await window.ltm.getPersonas();
  personas.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.name;
    personaSelect.appendChild(opt);
  });

  // Restore last model and persona from localStorage
  const lastModel = localStorage.getItem('lastModel');
  const lastPersona = localStorage.getItem('lastPersona');
  if (lastModel && [...modelSelect.options].some((o) => o.value === lastModel)) {
    modelSelect.value = lastModel;
  } else if (models.length > 0) {
    modelSelect.value = models[0].path;
  }
  if (lastPersona && [...personaSelect.options].some((o) => o.value === lastPersona)) {
    personaSelect.value = lastPersona;
  } else if (personas.length > 0) {
    const analytical = personas.find((p) => p.name === 'Analytical');
    personaSelect.value = analytical ? analytical.path : personas[0].path;
  }

  if (models.length > 0) {
    isInitialLoading = true;
    try {
      const personaName = getCurrentPersonaName();
      const settings = await window.ltm.getPersonaSettings(personaName);
      if (settings?.model && [...modelSelect.options].some((o) => o.value === settings.model)) {
        modelSelect.value = settings.model;
        modelPath = settings.model;
      }
      const isolateChk = document.getElementById('isolate-memory-chk');
      if (isolateChk) isolateChk.checked = !!settings?.isolate;
    } finally {
      isInitialLoading = false;
    }

    modelPath = modelSelect.value;
    const init = await initRagSession();
    if (!init.success) {
      console.log('[Renderer] Auto-init failed', init.error);
    } else {
      console.log('[Renderer] Auto-loaded model + persona');
      appendSystemMessage('System loaded and ready.');
    }
    updateUploadButtonState();
  } else {
    modelPath = await window.ltm.getDefaultModelPath();
    if (modelPath) {
      modelStatusEl.textContent = 'Model: not loaded (no .gguf in /models)';
      console.log('[Renderer] No models in /models, using default path fallback', { modelPath });
    } else {
      modelStatusEl.textContent = 'Model: not loaded';
    }
    modelSelect.disabled = true;
  }

  modelSelect.addEventListener('change', async (e) => {
    if (isInitialLoading) return;

    const newPath = e.target.value;
    const prevPath = modelPath;
    appendSystemMessage('Switching neural pathways... please standby.');
    localStorage.setItem('lastModel', newPath);
    updateUploadButtonState();

    const init = await initRagSession();
    if (!init.success) {
      e.target.value = prevPath || models[0]?.path || '';
      console.log('[Renderer] Model change failed', init.error);
    } else {
      modelPath = newPath;
      appendSystemMessage('System loaded and ready.');
      const isolateChk = document.getElementById('isolate-memory-chk');
      await window.ltm.savePersonaSettings(getCurrentPersonaName(), modelSelect.value, isolateChk?.checked ?? false);
    }
  });

  personaSelect.addEventListener('change', async () => {
    const personaName = getCurrentPersonaName();
    localStorage.setItem('lastPersona', personaSelect.value);

    isInitialLoading = true;

    // Clear short-term memory to prevent bleed between personas
    chatHistory = [];
    pendingBuffer = '';
    Array.from(output.children).forEach((child) => {
      if (child !== typingIndicator) child.remove();
    });
    appendSystemMessage('Persona switched. Ready for a fresh conversation.');

    try {
      const settings = await window.ltm.getPersonaSettings(personaName);

      if (settings?.model && [...modelSelect.options].some((o) => o.value === settings.model)) {
        modelSelect.value = settings.model;
        modelPath = settings.model;
      }
      const isolateChk = document.getElementById('isolate-memory-chk');
      if (isolateChk) isolateChk.checked = !!settings?.isolate;

      await initRagSession();
    } finally {
      isInitialLoading = false;
    }
  });

  const isolateChk = document.getElementById('isolate-memory-chk');
  if (isolateChk) {
    isolateChk.addEventListener('change', () => {
      if (isInitialLoading) return;
      window.ltm.savePersonaSettings(getCurrentPersonaName(), modelSelect.value, isolateChk.checked);
    });
  }

  // Image upload button: open file picker
  if (uploadImgBtn && imageInput) {
    uploadImgBtn.addEventListener('click', () => imageInput.click());
  }

  // Image input: process file, resize to max 1024px, export as Base64
  if (imageInput) {
    imageInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (uploadImgBtn) uploadImgBtn.textContent = 'Processing...';
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = dataUrl;
        });
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const maxDim = 1024;
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const base64String = canvas.toDataURL('image/jpeg', 0.8);
        currentBase64Image = base64String;
        document.getElementById('preview-img').src = currentBase64Image;
        document.getElementById('image-preview-container').style.display = 'block';
        document.getElementById('upload-img-btn').textContent = '📷 Image Added';
      } catch (err) {
        console.error('[Renderer] Image processing failed:', err);
      } finally {
        imageInput.value = '';
      }
    });
  }

  // Remove image button
  if (removeImgBtn) {
    removeImgBtn.addEventListener('click', () => {
      currentBase64Image = null;
      if (previewImg) previewImg.src = '';
      if (imagePreviewContainer) imagePreviewContainer.style.display = 'none';
    });
  }

  // Settings panel toggle
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const settingsClose = document.getElementById('settings-close');
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('closed'));
  }
  if (settingsClose && settingsPanel) {
    settingsClose.addEventListener('click', () => settingsPanel.classList.add('closed'));
  }

  // Settings tab switching
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const settingsPanels = document.querySelectorAll('.settings-tab-panel');
  settingsTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      settingsTabs.forEach((t) => t.classList.remove('active'));
      settingsPanels.forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${tabId}`);
      });
      tab.classList.add('active');
    });
  });
});

async function onChat() {
  const prompt = input.value.trim();
  if (!prompt) return;

  appendLine(prompt, 'user');
  input.value = '';

  setStatus('Initializing RAG…');
  btnChat.disabled = true;

  function showError(msg) {
    appendLine(`Error: ${msg}`, 'assistant');
    if (typingIndicator) typingIndicator.style.display = 'none';
    setStatus('Idle');
    const last = chatHistory[chatHistory.length - 1];
    if (last?.role === 'user' && last?.content === prompt) chatHistory.pop();
    btnChat.classList.remove('btn-processing');
    btnChat.textContent = 'Send';
    btnChat.disabled = false;
    input.focus();
  }

  if (!modelPath) {
    modelPath = window.prompt('Enter path to your .gguf model file:', '') || await window.ltm.getDefaultModelPath();
    if (!modelPath) {
      showError('No model path configured');
      return;
    }
  }

  try {
    const init = await initRagSession();
    if (!init.success) {
      console.error('[Renderer] Model load IPC error:', init.error);
      showError(init.error);
      return;
    }
    modelStatusEl.textContent = 'Model: loaded';
    console.log('[Renderer] Stream started');
    setStatus('Streaming…');

    const personaSelect = document.getElementById('persona-select');
    const currentPersona = personaSelect?.options[personaSelect.selectedIndex]?.text || 'Global';
    const isIsolated = document.getElementById('isolate-memory-chk')?.checked ?? false;

    const userMsg = currentBase64Image
      ? { role: 'user', content: prompt, images: [currentBase64Image] }
      : { role: 'user', content: prompt };
    chatHistory.push(userMsg);

    const payload = {
      text: prompt,
      image: currentBase64Image,
      chatHistory: [...chatHistory],
      persona: currentPersona,
      isolate: isIsolated
    };

    if (currentBase64Image) {
      btnChat.textContent = 'Processing Vision...';
      btnChat.classList.add('btn-processing');
    }
    await window.ltm.streamRagResponse(payload);

    currentBase64Image = null;
    if (previewImg) previewImg.src = '';
    if (imagePreviewContainer) imagePreviewContainer.style.display = 'none';
  } catch (e) {
    console.error('[Renderer] Chat exception:', e);
    showError(e.message);
  }
}

btnChat.addEventListener('click', onChat);

// Wipe LTM: clear database, chat UI, and show confirmation
document.getElementById('btn-wipe-ltm').addEventListener('click', async () => {
  try {
    const result = await window.ltm.clearMemory();
    if (result?.success) {
      Array.from(output.children).forEach((child) => {
        if (child !== typingIndicator) child.remove();
      });
      appendLine('$ Long-Term Memory completely wiped.', 'system');
    } else {
      appendLine(`Error: ${result?.error || 'Failed to wipe memory'}`, 'system');
    }
  } catch (e) {
    console.error('[Renderer] Wipe LTM error:', e);
    appendLine(`Error: ${e.message}`, 'system');
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onChat();
  }
});
