const fs = require('fs');
const path = require('path');

function walk(dir, callback) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}

function processFile(filePath) {
  if (!/\.(ts|tsx|md|js|mjs|sh|json|yml|yaml|tape)$/.test(filePath)) return;
  const oldContent = fs.readFileSync(filePath, 'utf-8');
  const newContent = oldContent
    .replace(/ensemble/g, 'agent-forge')
    .replace(/Ensemble/g, 'AgentForge')
    .replace(/ENSEMBLE/g, 'AGENT_FORGE');

  if (oldContent !== newContent) {
    fs.writeFileSync(filePath, newContent, 'utf-8');
    console.log(`Updated: ${filePath}`);
  }
}

walk('.', processFile);
