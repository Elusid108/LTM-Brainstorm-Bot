const fs = require('fs');
const path = require('path');
const { ingestBrainstorm } = require('./database.cjs');

let llama = null;
let model = null;
let context = null;
let session = null;
let modelPathConfigured = null;
let currentSystemPrompt = null;

async function createRagSession(modelPath, systemPrompt) {
  console.log('[LLM] Received request to load:', modelPath, 'systemPrompt length:', systemPrompt?.length);
  if (!modelPath) {
    console.log('[LLM] createRagSession: no modelPath, returning null');
    return null;
  }

  if (modelPathConfigured === modelPath && currentSystemPrompt === systemPrompt && session) {
    console.log('[LLM] createRagSession: reusing existing session');
    return { id: 'default' };
  }

  if (modelPathConfigured !== modelPath && (model || session)) {
    console.log('[LLM] Disposing of previous model to free VRAM...');
    session = null;
    context = null;
    model = null;
    modelPathConfigured = null;
    currentSystemPrompt = null;
  }

  if (modelPathConfigured === modelPath && currentSystemPrompt !== systemPrompt && model) {
    console.log('[LLM] Same model, different prompt: recreating session and context only');
    session = null;
    context = null;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (!model) {
    console.log('[LLM] createRagSession: loading model...');
    try {
      let visionModelPath = undefined;
      if (modelPath.includes('VL') || modelPath.includes('Vision')) {
        const dir = path.dirname(modelPath);
        const files = fs.readdirSync(dir);
        const projectorFile = files.find(f => f.includes('mmproj') && f.endsWith('.gguf'));
        if (projectorFile) {
          visionModelPath = path.join(dir, projectorFile);
          console.log('[LLM] Found attached vision projector:', visionModelPath);
        }
      }
      const { getLlama } = await import('node-llama-cpp');
      llama = await getLlama();
      const isVision = !!visionModelPath;
      model = await llama.loadModel({
        modelPath: path.resolve(modelPath),
        visionModelPath: visionModelPath ? path.resolve(visionModelPath) : undefined,
        gpuLayers: isVision ? 20 : 32
      });
      modelPathConfigured = modelPath;
    } catch (err) {
      console.error('[LLM] node-llama-cpp threw an error during load:', err.stack);
      throw err;
    }
  }

  try {
    const { LlamaChatSession } = await import('node-llama-cpp');
    context = await model.createContext({ contextSize: 4096 });
    session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: systemPrompt ?? ''
    });
    currentSystemPrompt = systemPrompt ?? '';
    console.log('[LLM] createRagSession: session ready');
    return { id: 'default' };
  } catch (err) {
    console.error('[LLM] node-llama-cpp threw an error during session creation:', err.stack);
    throw err;
  }
}

async function streamRagResponse(sessionId, promptPayload, onChunk) {
  const userText = promptPayload.text;
  const userImage = promptPayload.image;
  console.log('[LLM] streamRagResponse: starting', { sessionId, promptLength: userText?.length, hasImage: !!userImage });
  const { retrieveSimilar } = require('./database.cjs');
  if (!session) {
    console.error('[LLM] streamRagResponse: session not initialized');
    throw new Error('LLM session not initialized. Call createRagSession first.');
  }

  const results = await retrieveSimilar(userText, 5);
  console.log('[LLM] streamRagResponse: retrieved', results?.length, 'context items');
  const contextBlock = results.length
    ? results
        .map((r) => `- [${r.project_tags || 'general'}] ${r.text}`)
        .join('\n')
    : '(No relevant past thoughts in LTM)';

  const fullPrompt = contextBlock !== '(No relevant past thoughts in LTM)'
    ? `[SYSTEM NOTE: The following are historical interaction logs retrieved from Long-Term Memory. Use them to understand context, track name changes, and recall the Human's facts.]\n${contextBlock}\n\nHuman: ${userText}`
    : `Human: ${userText}`;

  console.log('[LLM] streamRagResponse: user message sent to session.prompt():\n---\n' + fullPrompt + '\n---');

  let finalInput = fullPrompt;
  if (userImage) {
    console.log('[LLM] Processing image payload...');
    const base64Data = userImage.replace(/^data:image\/\w+;base64,/, "");
    finalInput = [
      { type: "text", text: fullPrompt },
      { type: "image", data: base64Data }
    ];
  }

  console.log('--- CURRENT SHORT TERM MEMORY ---');
  console.dir(session.getChatHistory(), { depth: null });

  let assistantResponse;
  try {
    console.log('[LLM] Sending input to session.prompt...');
    const promptPromise = session.prompt(finalInput, {
      onTextChunk(chunk) {
        onChunk(chunk);
      },
    });
    assistantResponse = userImage
      ? await Promise.race([
          promptPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('VRAM Exhausted: Vision inference timed out after 30s. Try reducing image size or using a smaller model.')), 30000)
          )
        ])
      : await promptPromise;
    console.log('[LLM] session.prompt completed successfully.');
  } catch (error) {
    console.error('[LLM] CRITICAL ERROR during session.prompt:', error);
    // Send an error chunk to the frontend so the UI doesn't hang forever
    onChunk('\n\n*[System Error: The neural pathway collapsed. Check terminal for VRAM/Vision errors.]*');
    return null;
  }

  // Ingestion gatekeeping: avoid conversational filler
  if (userText.length >= 20) {
    // Strip emojis before saving to prevent emoji pollution in LTM
    const cleanedResponse = assistantResponse.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2300}-\u{23FF}\u{2B50}\u{2705}\u{274C}\u{274E}\u{2139}\u{2122}\u{00A9}\u{00AE}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E0}-\u{1F1FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();

    const firstSentence = cleanedResponse.split(/[.!?\n]/)[0].trim();
    if (firstSentence) {
      const memoryBlock = `Log - Human stated: "${userText}" | AI replied: "${firstSentence}"`;
      ingestBrainstorm(memoryBlock, ['auto-memory'])
        .then(() => console.log('✅ Auto-ingested to LTM'))
        .catch((err) => console.error('[LLM] Auto-ingest failed:', err));
    }
  }

  return assistantResponse;
}

module.exports = { createRagSession, streamRagResponse };
