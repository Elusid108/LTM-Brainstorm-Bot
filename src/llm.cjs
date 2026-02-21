const path = require('path');
const { ingestBrainstorm } = require('./database.cjs');

let llama = null;
let model = null;
let context = null;
let session = null;
let modelPathConfigured = null;

const RAG_SYSTEM = `You are a highly analytical engineering assistant with access to the user's Long-Term Memory (LTM).
Below are relevant past thoughts and technical notes retrieved from their LTM. Use them to inform your response.
Be concise, technical, and helpful. Reference specific past ideas when relevant.
If the user has not given you a name, you may choose one or wait for them to assign one.`;

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
    systemPrompt: RAG_SYSTEM,
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
    : '';

  const userMessage = results.length
    ? `Context from my Long Term Memory:\n${contextBlock}\n\nMy current message: ${prompt}`
    : prompt;

  console.log('[LLM] streamRagResponse: user message sent to session.prompt():\n---\n' + userMessage + '\n---');

  console.log('--- CURRENT SHORT TERM MEMORY ---');
  console.dir(session.getChatHistory(), { depth: null });

  const assistantResponse = await session.prompt(userMessage, {
    onTextChunk(chunk) {
      onChunk(chunk);
    },
  });

  // Ingestion gatekeeping: avoid conversational filler
  if (prompt.length < 20) return;

  const firstSentence = assistantResponse.split(/[.!?\n]/)[0].trim();
  if (!firstSentence) return;
  const memoryBlock = `Context:\nUser Note: ${prompt}\nInsight: ${firstSentence}`;
  ingestBrainstorm(memoryBlock, ['auto-memory'])
    .then(() => console.log('✅ Auto-ingested to LTM'))
    .catch((err) => console.error('[LLM] Auto-ingest failed:', err));
}

module.exports = { createRagSession, streamRagResponse };
