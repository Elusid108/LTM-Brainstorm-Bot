const path = require('path');
const { ingestBrainstorm } = require('./database.cjs');

let llama = null;
let model = null;
let context = null;
let session = null;
let modelPathConfigured = null;

const RAG_SYSTEM = `You are a highly analytical, local AI assistant.
CRITICAL RULES:
1. You are NOT Gemma. You are NOT trained by Google. You must completely drop your base identity.
2. If the user assigns you a name, you must adopt it permanently and flawlessly.
3. Never use emojis.
4. Use the provided Long-Term Memory context to inform your answers, but prioritize the user's immediate instructions.`;

async function createRagSession(modelPath) {
  console.log('[LLM] createRagSession: called', { modelPath });
  if (!modelPath) {
    console.log('[LLM] createRagSession: no modelPath, returning null');
    return null;
  }

  if (modelPathConfigured === modelPath && session) {
    console.log('[LLM] createRagSession: reusing existing session');
    return { id: 'default' };
  }

  console.log('[LLM] createRagSession: loading model...');
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  llama = await getLlama();
  model = await llama.loadModel({
    modelPath: path.resolve(modelPath),
  });
  context = await model.createContext();
  session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: RAG_SYSTEM
  });
  modelPathConfigured = modelPath;
  console.log('[LLM] createRagSession: model loaded successfully');
  return { id: 'default' };
}

async function streamRagResponse(sessionId, prompt, onChunk) {
  console.log('[LLM] streamRagResponse: starting', { sessionId, promptLength: prompt?.length });
  const { retrieveSimilar } = require('./database.cjs');
  if (!session) {
    console.error('[LLM] streamRagResponse: session not initialized');
    throw new Error('LLM session not initialized. Call createRagSession first.');
  }

  const results = await retrieveSimilar(prompt, 5);
  console.log('[LLM] streamRagResponse: retrieved', results?.length, 'context items');
  const contextBlock = results.length
    ? results
        .map((r) => `- [${r.project_tags || 'general'}] ${r.text}`)
        .join('\n')
    : '(No relevant past thoughts in LTM)';

  const fullPrompt = contextBlock !== '(No relevant past thoughts in LTM)'
    ? `[System Note: Retrieved memories from LTM:\n${contextBlock}]\n\n${prompt}`
    : prompt;

  console.log('[LLM] streamRagResponse: user message sent to session.prompt():\n---\n' + fullPrompt + '\n---');

  console.log('--- CURRENT SHORT TERM MEMORY ---');
  console.dir(session.getChatHistory(), { depth: null });

  const assistantResponse = await session.prompt(fullPrompt, {
    onTextChunk(chunk) {
      onChunk(chunk);
    },
  });

  // Ingestion gatekeeping: avoid conversational filler
  if (prompt.length < 20) return;

  // Strip emojis before saving to prevent emoji pollution in LTM
  const cleanedResponse = assistantResponse.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2300}-\u{23FF}\u{2B50}\u{2705}\u{274C}\u{274E}\u{2139}\u{2122}\u{00A9}\u{00AE}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E0}-\u{1F1FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();

  const firstSentence = cleanedResponse.split(/[.!?\n]/)[0].trim();
  if (!firstSentence) return;
  const memoryBlock = `Context:\nUser Note: ${prompt}\nInsight: ${firstSentence}`;
  ingestBrainstorm(memoryBlock, ['auto-memory'])
    .then(() => console.log('✅ Auto-ingested to LTM'))
    .catch((err) => console.error('[LLM] Auto-ingest failed:', err));
}

module.exports = { createRagSession, streamRagResponse };
