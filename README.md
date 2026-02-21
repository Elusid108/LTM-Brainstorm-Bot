# LTM Brainstorm

A local-first Electron application serving as the core engine for an always-on, JARVIS-style AI brainstorming assistant with **Long-Term Memory (LTM)**. Ingest, semantically connect, and rapidly recall technical ideas across software development, hardware prototyping, robotics R&D, and 3D printing projects.

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS — terminal-inspired minimalist interface
- **Backend**: Node.js (Electron main process)
- **Database**: SQLite3 + sqlite-vec extension (vector storage)
- **LLM**: node-llama-cpp (local .gguf Gemma model)
- **Embeddings**: @xenova/transformers (all-MiniLM-L6-v2, 384-dim vectors)

## Project Structure

```
LTM Brainstorm/
├── main.cjs              # Electron main process, IPC handlers
├── preload.cjs           # IPC bridge for renderer
├── index.html            # App shell
├── styles.css            # Terminal-inspired UI
├── renderer.js           # Frontend logic
├── src/
│   ├── database.cjs      # SQLite + sqlite-vec, brainstorms + vec_brainstorms
│   ├── embeddings.js     # Xenova transformers (all-MiniLM-L6-v2)
│   └── llm.cjs           # node-llama-cpp RAG session + streaming
└── package.json
```

## Setup

```bash
npm install
npm start
```

## Model Path

**You need to provide the local path to your .gguf Gemma model.** When you first click **Chat**, the app will prompt you for the path. Example:

- `C:\Users\You\models\gemma-2b-it-Q4_K_M.gguf`
- Or any compatible instruct-tuned .gguf model

## Usage

1. **Ingest** — Type a thought or technical note and click **Ingest** (or press Enter). The text is embedded and stored in SQLite with its vector.
2. **Chat** — Ask a question. The app retrieves the top 5 semantically similar past brainstorms, passes them as context to the LLM, and streams the response.

## Database

- **brainstorms**: `id`, `text`, `project_tags`, `created_at`
- **vec_brainstorms**: vec0 virtual table with 384-dim cosine-distance vectors

Data is stored in `%APPDATA%/ltm-brainstorm/ltm-brainstorm.db` (Windows).
