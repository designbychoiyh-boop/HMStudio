const fs = require('fs');
const content = fs.readFileSync('src/App.tsx', 'utf8');
const lines = content.split('\n');
const targetLine = '                <div key={f.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 8 }}>';
const startIdx = lines.findIndex(l => l.includes(targetLine));

let open = 0;
for (let i = 0; i <= startIdx; i++) {
    for (let char of lines[i]) {
        if (char === '{') open++;
        if (char === '}') open--;
    }
}
console.log(`Balance up to startIdx: ${open}`);
