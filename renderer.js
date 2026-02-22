const output = document.getElementById('output');
const input = document.getElementById('input');
const btnChat = document.getElementById('btn-chat');
const statusEl = document.getElementById('status');
const modelStatusEl = document.getElementById('model-status');

let modelPath = null;
let activeAssistantBubble = null;
let hasStrippedJarvisPrefix = false;

// Stream handlers - no onStreamChunk; we use onStreamDone with finalText only
window.ltm.onStreamDone((finalText) => {
  console.log('[Renderer] Stream completed');
  // Remove the typing indicator bubble
  if (activeAssistantBubble) {
    activeAssistantBubble.remove();
    activeAssistantBubble = null;
  }

  let text = (finalText ?? '').trim();
  if (/^JARVIS Insight:\s*/i.test(text)) {
    text = text.replace(/^JARVIS Insight:\s*/i, '');
  }

  const paragraphs = text ? text.split('\n\n').filter((p) => p.trim() !== '') : [];
  const toAppend = paragraphs.length > 0 ? paragraphs : [text || ''];

  for (const p of toAppend) {
    appendLine(p, 'assistant');
  }

  hasStrippedJarvisPrefix = false;
  setStatus('Idle');
  btnChat.disabled = false;
  input.focus();
  output.scrollTop = output.scrollHeight;
});

window.ltm.onStreamError((err) => {
  console.error('[Renderer] Stream IPC error:', err);
  if (activeAssistantBubble) {
    activeAssistantBubble.classList.remove('streaming');
    const contentEl = activeAssistantBubble.querySelector('.bubble-content');
    if (contentEl) contentEl.textContent = `Error: ${err}`;
  }
  activeAssistantBubble = null;
  hasStrippedJarvisPrefix = false;
  setStatus('Idle');
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
  output.appendChild(el);
  output.scrollTop = output.scrollHeight;
}

/**
 * Appends a chat bubble to the output.
 * @param {string} content - The message text
 * @param {'user'|'assistant'|'system'|'ingest'} sender - Sender type
 * @returns {HTMLElement} The bubble element
 */
function appendLine(content, sender = 'system') {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${sender}`;
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

  output.appendChild(bubble);
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
    }
  });

  personaSelect.addEventListener('change', async () => {
    localStorage.setItem('lastPersona', personaSelect.value);
    console.log('[Renderer] Persona changed');
    await initRagSession();
  });

  // Image upload button: open file picker
  const uploadImgBtn = document.getElementById('upload-img-btn');
  const imageInput = document.getElementById('image-input');
  if (uploadImgBtn && imageInput) {
    uploadImgBtn.addEventListener('click', () => imageInput.click());
  }
});

async function onChat() {
  const text = input.value.trim();
  if (!text) return;

  appendLine(text, 'user');
  input.value = '';

  const bubble = appendLine('', 'assistant');
  bubble.classList.add('streaming');
  const contentEl = bubble.querySelector('.bubble-content');
  contentEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  activeAssistantBubble = bubble;

  setStatus('Initializing RAG…');
  btnChat.disabled = true;

  function showErrorInBubble(msg) {
    contentEl.innerHTML = '';
    contentEl.textContent = msg;
    bubble.classList.remove('streaming');
    activeAssistantBubble = null;
    setStatus('Idle');
    btnChat.disabled = false;
    input.focus();
  }

  if (!modelPath) {
    modelPath = prompt('Enter path to your .gguf model file:', '') || await window.ltm.getDefaultModelPath();
    if (!modelPath) {
      showErrorInBubble('Error: No model path configured');
      return;
    }
  }

  try {
    const init = await initRagSession();
    if (!init.success) {
      console.error('[Renderer] Model load IPC error:', init.error);
      showErrorInBubble(`Error: ${init.error}`);
      return;
    }
    modelStatusEl.textContent = 'Model: loaded';
    console.log('[Renderer] Stream started');
    setStatus('Streaming…');
    await window.ltm.streamRag(text);
  } catch (e) {
    console.error('[Renderer] Chat exception:', e);
    showErrorInBubble(`Error: ${e.message}`);
  }
}

btnChat.addEventListener('click', onChat);

// Wipe LTM: clear database, chat UI, and show confirmation
document.getElementById('btn-wipe-ltm').addEventListener('click', async () => {
  try {
    const result = await window.ltm.clearMemory();
    if (result?.success) {
      output.innerHTML = '';
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
