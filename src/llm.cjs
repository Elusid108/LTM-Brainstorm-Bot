const { ingestBrainstorm } = require('./database.cjs');

let activeModel = '';
let activeSystemPrompt = '';

async function createRagSession(modelPath, systemPrompt) {
  console.log('[LLM] Received request to load:', modelPath, 'systemPrompt length:', systemPrompt?.length);
  if (!modelPath) {
    console.log('[LLM] createRagSession: no modelPath, returning null');
    return null;
  }
  activeModel = modelPath;
  const globalFormattingRule = `\n\n[GLOBAL FORMATTING RULE]\nAlways enclose all physical actions, non-verbal cues, internal thoughts, and environmental descriptions within asterisks (*like this*). Speak dialogue normally without asterisks.`;
  activeSystemPrompt = (systemPrompt ?? '') + globalFormattingRule;
  console.log('[LLM] createRagSession: Ollama model set');
  return true;
}

function stripDataUrl(img) {
  if (typeof img === 'string') {
    return img.replace(/^data:image\/\w+;base64,/, '');
  }
  if (Buffer.isBuffer(img)) return img.toString('base64');
  return String(img);
}

async function streamRagResponse(sessionId, promptPayload, onChunk) {
  const { text: userText, image: userImage, chatHistory = [], persona, isolate, contextLength } = promptPayload;
  console.log('[LLM] streamRagResponse: starting', { sessionId, promptLength: userText?.length, hasImage: !!userImage, chatHistoryLen: chatHistory?.length, persona, isolate });
  const { retrieveSimilar } = require('./database.cjs');
  if (!activeModel) {
    console.error('[LLM] streamRagResponse: session not initialized');
    throw new Error('LLM session not initialized. Call createRagSession first.');
  }

  const results = await retrieveSimilar(userText, 5, { persona, isolate });
  console.log('[LLM] streamRagResponse: retrieved', results?.length, 'context items');
  const contextBlock = results.length
    ? results
        .map((r) => `- [${r.project_tags || 'general'}] ${r.text}`)
        .join('\n')
    : '(No relevant past thoughts in LTM)';

  const ltmNote = contextBlock !== '(No relevant past thoughts in LTM)'
    ? `\n\n[SYSTEM NOTE: The following are historical interaction logs retrieved from Long-Term Memory. Use them to understand context, track name changes, and recall the Human's facts.]\n${contextBlock}`
    : '';

  const systemContent = (activeSystemPrompt || '') + ltmNote;

  const messages = [];
  if (systemContent.trim()) {
    messages.push({ role: 'system', content: systemContent.trim() });
  }

  for (const m of chatHistory) {
    if (m.role === 'user') {
      const msg = { role: 'user', content: m.content };
      if (m.images?.length) {
        msg.images = m.images.map(stripDataUrl);
        console.log('[LLM] Attaching image(s) to user message in history');
      }
      messages.push(msg);
    } else if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.content || '' });
    }
  }

  let fullResponse = '';
  try {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: activeModel, messages, stream: true, options: { num_ctx: contextLength ?? 8192 } }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            fullResponse += data.message.content;
            onChunk(data.message.content);
          }
        } catch (e) {
          // Skip malformed JSON lines
        }
      }
    }
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.message?.content) {
          fullResponse += data.message.content;
          onChunk(data.message.content);
        }
      } catch (e) {
        // Skip
      }
    }
    console.log('[LLM] streamRagResponse: Ollama stream completed');
  } catch (error) {
    console.error('[LLM] CRITICAL ERROR during Ollama request:', error);
    onChunk('\n\n*[System Error: Could not reach Ollama. Ensure Ollama is running on localhost:11434.]*');
    return null;
  }

  // Ingestion gatekeeping: avoid conversational filler
  if (fullResponse && userText && userText.length >= 20) {
    const cleanedResponse = fullResponse.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2300}-\u{23FF}\u{2B50}\u{2705}\u{274C}\u{274E}\u{2139}\u{2122}\u{00A9}\u{00AE}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E0}-\u{1F1FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
    const firstSentence = cleanedResponse.split(/[.!?\n]/)[0].trim();
    if (firstSentence) {
      const memoryBlock = `Log - Human stated: "${userText}" | AI replied: "${firstSentence}"`;
      const personaTag = isolate ? (persona || 'Global') : 'Global';
      ingestBrainstorm(memoryBlock, ['auto-memory'], personaTag)
        .then(() => console.log('✅ Auto-ingested to LTM'))
        .catch((err) => console.error('[LLM] Auto-ingest failed:', err));
    }
  }

  return fullResponse;
}

module.exports = { createRagSession, streamRagResponse };
