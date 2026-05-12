import { exec } from 'child_process';

const psCommand = `
  $shell = New-Object -ComObject Shell.Application;
  $folder = $shell.BrowseForFolder(0, '렌더링을 저장할 폴더를 선택하세요.', 0x00000010 + 0x00000040, 0);
  if ($folder) {
    $folder.Self.Path;
  }
`;

const fullCommand = `powershell -Sta -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${psCommand.replace(/\n/g, ' ')}"`;

console.log('Running command:', fullCommand);
exec(fullCommand, { encoding: 'utf8' }, (error, stdout, stderr) => {
  if (error) {
    console.error('Error:', error);
  }
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
});
