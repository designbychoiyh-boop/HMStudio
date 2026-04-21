const fs = require('fs');
const path = 'src/App.tsx';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

const targetLine = '                <div key={f.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 8 }}>';
const startIdx = lines.findIndex(l => l.includes(targetLine));

if (startIdx === -1) {
  console.log('Target line not found');
  process.exit(1);
}

// Keep everything before the insertion point
const header = lines.slice(0, startIdx + 1).join('\n') + '\n';

// Read the new section from the text file
const body = fs.readFileSync('scratch/new_section_v3.txt', 'utf8');

fs.writeFileSync(path, header + body, 'utf8');
console.log('Fixed!');
