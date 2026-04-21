const fs = require('fs');
const content = fs.readFileSync('scratch/new_section_v2.txt', 'utf8');
let open = 0;
for (let char of content) {
    if (char === '{') open++;
    if (char === '}') open--;
}
console.log(`Section balance: ${open}`);
