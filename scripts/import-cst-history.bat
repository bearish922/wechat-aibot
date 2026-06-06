@echo off
cd /d "%~dp0.."

echo ============================================
echo   cst Chat History Import
echo ============================================
echo.
echo Reads: data\cst-chat-history-export.jsonl
echo Writes: data\wechat-sessions.json (cst session)
echo.
echo Make sure the bot is STOPPED.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$jsonl = Join-Path $pwd 'data\cst-chat-history-export.jsonl';" ^
  "$sessPath = Join-Path $pwd 'data\wechat-sessions.json';" ^
  "if (-not (Test-Path $jsonl)) { Write-Host 'ERROR: export file not found' -ForegroundColor Red; exit 1 };" ^
  "$lines = Get-Content $jsonl -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() };" ^
  "$newHistory = @();" ^
  "foreach ($line in $lines) {" ^
  "  try { $obj = $line | ConvertFrom-Json; if ($obj.role -and $obj.content) { $newHistory += @{ role = $obj.role; content = $obj.content } } } catch {}" ^
  "};" ^
  "Write-Host \"Parsed $($newHistory.Count) messages\";" ^
  "$sessions = Get-Content $sessPath -Raw -Encoding UTF8 | ConvertFrom-Json;" ^
  "$found = $false;" ^
  "foreach ($uid in $sessions.cc.PSObject.Properties.Name) {" ^
  "  foreach ($item in $sessions.cc.$uid.list) {" ^
  "    if ($item.name -eq 'cst') {" ^
  "      $item._chatHistory = $newHistory;" ^
  "      $item._chatSummary = '';" ^
  "      $found = $true;" ^
  "      Write-Host \"Updated cst (user=$uid)\" -ForegroundColor Green" ^
  "    }" ^
  "  }" ^
  "};" ^
  "if (-not $found) { Write-Host 'WARNING: cst session not found' -ForegroundColor Yellow; exit 1 };" ^
  "$json = $sessions | ConvertTo-Json -Depth 10;" ^
  "[System.IO.File]::WriteAllText($sessPath, $json, [System.Text.UTF8Encoding]::new(`$false));" ^
  "Write-Host 'Done. Restart the bot.' -ForegroundColor Green"

pause
