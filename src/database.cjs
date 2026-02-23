const path = require('path');
const { getLoadablePath } = require('sqlite-vec');
const sqlite3 = require('sqlite3').verbose();

let db = null;

function getDb() {
  return db;
}

function initDatabase(dbPath) {
  console.log('[DB] initDatabase: starting', { dbPath });
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error in initDatabase (open):', err);
        return reject(err);
      }

      db.loadExtension(getLoadablePath(), (extErr) => {
        if (extErr) {
          console.error('Error in initDatabase (loadExtension):', extErr);
          return reject(extErr);
        }

        db.serialize(() => {
          db.run(`
            CREATE TABLE IF NOT EXISTS brainstorms (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              text TEXT NOT NULL,
              project_tags TEXT,
              created_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
          `);

          db.run("ALTER TABLE brainstorms ADD COLUMN persona TEXT DEFAULT 'Global'", (alterErr) => {
            if (alterErr && !alterErr.message.includes('duplicate column')) {
              console.warn('[DB] ALTER TABLE persona:', alterErr.message);
            } else if (!alterErr) {
              console.log('[DB] Added persona column to brainstorms table');
            }
          });

          db.run("UPDATE brainstorms SET persona = 'Global' WHERE persona IS NULL", (updateErr) => {
            if (updateErr) console.warn('[DB] Backfill persona:', updateErr.message);
          });

          db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_brainstorms USING vec0(
              brainstorm_id INTEGER PRIMARY KEY,
              embedding float[384] distance_metric=cosine
            )
          `, (vtErr) => {
            if (vtErr) {
              console.warn('vec0 table may already exist or schema differs:', vtErr.message);
            }
            console.log('[DB] initDatabase: complete');
            resolve();
          });
        });
      });
    });
  });
}

async function ingestBrainstorm(text, projectTags = [], persona = 'Global') {
  console.log('[DB] ingestBrainstorm: starting', { textLength: text?.length, textPreview: text?.slice(0, 80), persona });
  const { embedText } = await import('./embeddings.js');
  return new Promise(async (resolve, reject) => {
    try {
      const embedding = await embedText(text);
      console.log('[DB] ingestBrainstorm: embedding computed', { dim: embedding?.length });
      const tagsStr = Array.isArray(projectTags) ? projectTags.join(',') : String(projectTags);

      db.run(
        'INSERT INTO brainstorms (text, project_tags, persona) VALUES (?, ?, ?)',
        [text, tagsStr, persona],
        function (err) {
          if (err) {
            console.error('Error in ingestBrainstorm (INSERT brainstorms):', err);
            return reject(err);
          }
          const id = this.lastID;

          const vecJson = JSON.stringify(Array.from(embedding));
          db.run(
            'INSERT INTO vec_brainstorms (brainstorm_id, embedding) VALUES (?, ?)',
            [id, vecJson],
            (vecErr) => {
              if (vecErr) {
                console.error('Error in ingestBrainstorm (INSERT vec_brainstorms):', vecErr);
                db.run('DELETE FROM brainstorms WHERE id = ?', [id]);
                return reject(vecErr);
              }
              console.log('[DB] ingestBrainstorm: saved successfully', { id });
              resolve(id);
            }
          );
        }
      );
    } catch (e) {
      console.error('Error in ingestBrainstorm:', e);
      reject(e);
    }
  });
}

async function retrieveSimilar(query, limit = 5, options = {}) {
  const { persona, isolate } = options;
  console.log('[DB] retrieveSimilar: starting', { query, limit, persona, isolate });
  const { embedText } = await import('./embeddings.js');
  return new Promise(async (resolve, reject) => {
    try {
      const queryEmbedding = await embedText(query);
      const vecJson = JSON.stringify(Array.from(queryEmbedding));
      console.log('[DB] retrieveSimilar: query embedding computed', { dim: queryEmbedding?.length });

      const k = isolate ? Math.max(limit, 15) : limit;
      const sql = isolate
        ? `SELECT v.brainstorm_id as id, b.text, b.project_tags, b.created_at, v.distance
           FROM vec_brainstorms v
           JOIN brainstorms b ON b.id = v.brainstorm_id
           WHERE v.embedding MATCH ? AND k = ?
             AND (b.persona = ? OR b.persona = 'Global')`
        : `SELECT v.brainstorm_id as id, b.text, b.project_tags, b.created_at, v.distance
           FROM vec_brainstorms v
           JOIN brainstorms b ON b.id = v.brainstorm_id
           WHERE v.embedding MATCH ? AND k = ?`;
      const params = isolate ? [vecJson, k, persona || 'Global'] : [vecJson, k];

      db.all(sql, params,
        (err, rows) => {
          if (err) {
            console.error('Error in retrieveSimilar:', err);
            return reject(err);
          }
          const results = (rows || []).slice(0, limit);
          const relevantRows = results.filter(row => row.distance < 0.75);
          console.log('[DB] retrieveSimilar: retrieved rows', results.map(r => ({
            id: r.id,
            textPreview: r.text?.slice(0, 60),
            distance: r.distance,
          })));
          console.log('[DB] retrieveSimilar: after distance filter (<0.75)', relevantRows.length);
          resolve(relevantRows);
        }
      );
    } catch (e) {
      console.error('Error in retrieveSimilar:', e);
      reject(e);
    }
  });
}

function clearMemory() {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized'));
    }
    db.serialize(() => {
      db.run('DELETE FROM vec_brainstorms', (vecErr) => {
        if (vecErr) {
          console.error('Error in clearMemory (vec_brainstorms):', vecErr);
          return reject(vecErr);
        }
        db.run('DELETE FROM brainstorms', (brainErr) => {
          if (brainErr) {
            console.error('Error in clearMemory (brainstorms):', brainErr);
            return reject(brainErr);
          }
          console.log('[DB] clearMemory: complete');
          resolve();
        });
      });
    });
  });
}

module.exports = { getDb, initDatabase, ingestBrainstorm, retrieveSimilar, clearMemory };
