const output = document.getElementById('output');
const input = document.getElementById('input');
const btnChat = document.getElementById('btn-chat');
const statusEl = document.getElementById('status');
const modelStatusEl = document.getElementById('model-status');

let modelPath = null;
let activeAssistantBubble = null;
let isFirstChunk = true;
let hasStrippedJarvisPrefix = false;

// Stream handlers - registered once to avoid memory leaks
window.ltm.onStreamChunk((chunk) => {
  if (!activeAssistantBubble) return;
  const contentEl = activeAssistantBubble.querySelector('.bubble-content');
  if (!contentEl) return;
  if (isFirstChunk) {
    contentEl.innerHTML = ''; // Clear the typing dots
    isFirstChunk = false;
  }
  contentEl.textContent += chunk;
  if (!hasStrippedJarvisPrefix && /^JARVIS Insight:\s*/i.test(contentEl.textContent)) {
    contentEl.textContent = contentEl.textContent.replace(/^JARVIS Insight:\s*/i, '');
    hasStrippedJarvisPrefix = true;
  }
  output.scrollTop = output.scrollHeight;
});

window.ltm.onStreamDone(() => {
  console.log('[Renderer] Stream completed');
  if (activeAssistantBubble) {
    activeAssistantBubble.classList.remove('streaming');
  }
  activeAssistantBubble = null;
  hasStrippedJarvisPrefix = false;
  setStatus('Idle');
  btnChat.disabled = false;
  input.focus();
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

// Set models dropdown, version, and auto-init first model on load
window.addEventListener('DOMContentLoaded', async () => {
  const version = await window.ltm.getAppVersion();
  document.getElementById('version').textContent = `v${version}`;

  const models = await window.ltm.getModels();
  const modelSelect = document.getElementById('model-select');

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.path;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });

  if (models.length > 0) {
    modelSelect.value = models[0].path;
    modelPath = models[0].path;
    modelStatusEl.textContent = 'Loading...';
    try {
      const init = await window.ltm.initRagChat(models[0].path);
      if (init.success) {
        modelStatusEl.textContent = 'Model: Loaded';
        console.log('[Renderer] Auto-loaded first model', { path: models[0].path });
      } else {
        modelStatusEl.textContent = `Model: Error - ${init.error}`;
      }
    } catch (e) {
      modelStatusEl.textContent = `Model: Error - ${e.message}`;
    }
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
    console.log('Frontend: Requesting model swap to ->', newPath);
    modelStatusEl.textContent = 'Loading...';
    try {
      const init = await window.ltm.initRagChat(newPath);
      if (init.success) {
        modelPath = newPath;
        modelStatusEl.textContent = 'Model: Loaded';
      } else {
        modelStatusEl.textContent = `Model: Error - ${init.error}`;
        e.target.value = prevPath || models[0]?.path || '';
      }
    } catch (err) {
      console.error('Frontend IPC Error:', err);
      modelStatusEl.textContent = 'Model Load Failed';
      e.target.value = prevPath || models[0]?.path || '';
    }
  });
});

/**
 * Appends a chat bubble to the output.
 * @param {string} content - The message text
 * @param {'user'|'assistant'|'system'|'ingest'} type - Sender type
 * @returns {HTMLElement} The bubble element (with .bubble-content child for streaming)
 */
function appendLine(content, type = 'system') {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${type}`;
  const contentEl = document.createElement('div');
  contentEl.className = 'bubble-content';
  contentEl.textContent = content;
  bubble.appendChild(contentEl);
  output.appendChild(bubble);
  output.scrollTop = output.scrollHeight;
  return bubble;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function onChat() {
  const text = input.value.trim();
  if (!text) return;

  // Immediate UI update - before any await
  appendLine(text, 'user');
  input.value = '';

  const bubble = appendLine('', 'assistant');
  bubble.classList.add('streaming');
  const contentEl = bubble.querySelector('.bubble-content');
  contentEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  activeAssistantBubble = bubble;
  isFirstChunk = true;
  hasStrippedJarvisPrefix = false;

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
    const init = await window.ltm.initRagChat(modelPath);
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
