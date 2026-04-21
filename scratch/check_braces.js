const fs = require('fs');
const content = fs.readFileSync('src/App.tsx', 'utf8');
let open = 0;
let lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    for (let char of line) {
        if (char === '{') open++;
        if (char === '}') open--;
    }
    if (open < 0) {
        console.log(`Line ${i+1}: extra closing brace`);
        break;
    }
}
console.log(`Final balance: ${open}`);
