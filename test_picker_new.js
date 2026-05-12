import { exec } from 'child_process';

const psCommand = `
  Add-Type -AssemblyName System.Windows.Forms;
  $signature = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);';
  $type = Add-Type -MemberDefinition $signature -Name "Win32SetForegroundWindow" -Namespace "Win32" -PassThru;
  $form = New-Object System.Windows.Forms.Form;
  $form.Width = 1;
  $form.Height = 1;
  $form.StartPosition = 'CenterScreen';
  $form.ShowInTaskbar = $false;
  $form.TopMost = $true;
  $form.Opacity = 0;
  $form.Add_Shown({
    [Win32.Win32SetForegroundWindow]::SetForegroundWindow($form.Handle);
    $form.Activate();
    $form.Focus();
    $f = New-Object System.Windows.Forms.FolderBrowserDialog;
    $f.Description = '렌더링을 저장할 폴더를 선택하세요.';
    if ($f.ShowDialog($form) -eq 'OK') {
      Write-Output $f.SelectedPath;
    }
    $form.Close();
  });
  [void]$form.ShowDialog();
`;

const fullCommand = `powershell -Sta -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${psCommand.replace(/\\n/g, ' ')}"`;

console.log('Running command:', fullCommand);
exec(fullCommand, { encoding: 'utf8' }, (error, stdout, stderr) => {
  if (error) {
    console.error('Error:', error);
  }
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
});
