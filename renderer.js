const output = document.getElementById('output');
const input = document.getElementById('input');
const btnChat = document.getElementById('btn-chat');
const statusEl = document.getElementById('status');
const modelStatusEl = document.getElementById('model-status');

let modelPath = null;

// Set default model path and version on load
window.addEventListener('DOMContentLoaded', async () => {
  const version = await window.ltm.getAppVersion();
  document.getElementById('version').textContent = `v${version}`;
  console.log('[Renderer] DOMContentLoaded: fetching default model path');
  modelPath = await window.ltm.getDefaultModelPath();
  if (modelPath) {
    document.getElementById('model-status').textContent = 'Model: gemma-2-2b-it (default)';
    console.log('[Renderer] Default model path set', { modelPath });
  } else {
    console.log('[Renderer] No default model path');
  }
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

  if (!modelPath) {
    console.log('[Renderer] No model path, prompting user');
    modelPath = prompt('Enter path to your .gguf model file:', '') || await window.ltm.getDefaultModelPath();
    if (!modelPath) return;
  }

  console.log('[Renderer] Chat: attempting to load model...', { modelPath });
  setStatus('Initializing RAG…');
  btnChat.disabled = true;

  try {
    const init = await window.ltm.initRagChat(modelPath);
    if (!init.success) {
      console.error('[Renderer] Model load IPC error:', init.error);
      appendLine(`Error: ${init.error}`, 'system');
      setStatus('Idle');
      btnChat.disabled = false;
      input.focus();
      return;
    }
    console.log('[Renderer] Model loaded successfully');
    modelStatusEl.textContent = `Model: loaded`;

    appendLine(text, 'user');
    input.value = '';

    const bubble = appendLine('', 'assistant');
    bubble.classList.add('streaming');
    const contentEl = bubble.querySelector('.bubble-content');

    window.ltm.onStreamChunk((chunk) => {
      contentEl.textContent += chunk;
      output.scrollTop = output.scrollHeight;
    });

    window.ltm.onStreamDone(() => {
      console.log('[Renderer] Stream completed');
      bubble.classList.remove('streaming');
      setStatus('Idle');
      btnChat.disabled = false;
      input.focus();
    });

    window.ltm.onStreamError((err) => {
      console.error('[Renderer] Stream IPC error:', err);
      bubble.classList.remove('streaming');
      contentEl.textContent = `Error: ${err}`;
      setStatus('Idle');
      btnChat.disabled = false;
      input.focus();
    });

    console.log('[Renderer] Stream started');
    setStatus('Streaming…');
    await window.ltm.streamRag(text);
  } catch (e) {
    console.error('[Renderer] Chat exception:', e);
    appendLine(`Error: ${e.message}`, 'system');
    setStatus('Idle');
    btnChat.disabled = false;
    input.focus();
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
