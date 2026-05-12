import { exec } from 'child_process';

const psCommand = `
  Add-Type -AssemblyName System.Windows.Forms;
  $f = New-Object System.Windows.Forms.FolderBrowserDialog;
  $f.Description = '렌더링을 저장할 폴더를 선택하세요.';
  $form = New-Object System.Windows.Forms.Form;
  $form.WindowState = 'Minimized';
  $form.Show();
  $form.Activate();
  $form.TopMost = $true;
  $res = $f.ShowDialog($form);
  $form.Close();
  if($res -eq 'OK') {
    $f.SelectedPath
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
