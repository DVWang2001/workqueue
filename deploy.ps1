# WorkQueue 部署腳本
# 用法：在 web 目錄執行 .\deploy.ps1 或 .\deploy.ps1 "說明文字"

param([string]$Message = "")

Set-Location $PSScriptRoot

# 確認有變更
$status = git status --porcelain
if (-not $status) {
    Write-Host "沒有任何變更需要部署。" -ForegroundColor Yellow
    exit 0
}

# 取得 commit 訊息
if (-not $Message) {
    $Message = Read-Host "本次更新說明（直接 Enter 略過）"
    if (-not $Message) { $Message = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
}

# 執行
git add .
git commit -m $Message
git push

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "已推送，Vercel 約 30 秒後完成部署。" -ForegroundColor Green
} else {
    Write-Host "Push 失敗，請檢查網路或 GitHub 設定。" -ForegroundColor Red
}
