Select-String -Path src/App.tsx -Pattern 'type="number"' | Select-Object LineNumber, Line
