$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$identityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'AWS authentication is unavailable. Run aws login in your terminal, then retry.' }
$identity = $identityJson | ConvertFrom-Json
$env:CDK_DEFAULT_ACCOUNT = $identity.Account
if (-not $env:CDK_DEFAULT_REGION) { $env:CDK_DEFAULT_REGION = aws configure get region }
if (-not $env:CDK_DEFAULT_REGION) { throw 'Configure the AWS region for your account before deploying.' }
$artifactDirectory = Join-Path (Get-Location) '.artifacts'
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$outputsFile = Join-Path $artifactDirectory 'aws-outputs.json'
npm run deploy --prefix infra/cdk -- --require-approval never --outputs-file $outputsFile
if ($LASTEXITCODE -ne 0) { throw 'CDK deployment failed; no smoke success is claimed.' }
$outputs = Get-Content -LiteralPath $outputsFile -Raw | ConvertFrom-Json
$layers = @($outputs.PSObject.Properties.Value)
$web = $layers | Where-Object { $_.AmplifyAppId }
$data = $layers | Where-Object { $_.DemoTargetUrl }
$api = $layers | Where-Object { $_.ApiUrl }
if (-not $web -or -not $data -or -not $api) { throw 'Deployment outputs are incomplete.' }
$env:VITE_API_BASE_URL = '/api'
$env:VITE_AUTHORIZED_DOMAINS = ([Uri]$data.DemoTargetUrl).Host
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
$zipPath = Join-Path $artifactDirectory 'aws-console.zip'
Compress-Archive -Path 'apps/web/dist/*' -DestinationPath $zipPath -Force
$deploymentJson = aws amplify create-deployment --app-id $web.AmplifyAppId --branch-name $web.AmplifyBranchName --output json
if ($LASTEXITCODE -ne 0) { throw 'Amplify deployment creation failed.' }
$deployment = $deploymentJson | ConvertFrom-Json
Invoke-WebRequest -Uri $deployment.zipUploadUrl -Method Put -InFile $zipPath -ContentType 'application/zip' -UseBasicParsing | Out-Null
aws amplify start-deployment --app-id $web.AmplifyAppId --branch-name $web.AmplifyBranchName --job-id $deployment.jobId --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Amplify deployment could not start.' }
$deadline = (Get-Date).AddMinutes(10)
do {
    $jobJson = aws amplify get-job --app-id $web.AmplifyAppId --branch-name $web.AmplifyBranchName --job-id $deployment.jobId --output json
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Amplify deployment.' }
    $status = ($jobJson | ConvertFrom-Json).job.summary.status
    if ($status -in @('FAILED', 'CANCELLED')) { throw "Amplify deployment ended $status." }
    if ($status -eq 'SUCCEED') { break }
    Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)
if ($status -ne 'SUCCEED') { throw 'Amplify deployment timed out.' }
# Exercise the same Amplify-to-API proxy the deployed console uses.
$env:BETAVERSION_API_URL = $web.SiteUrl + '/api'
$env:BETAVERSION_DEMO_URL = $data.DemoTargetUrl
npm run aws:smoke
if ($LASTEXITCODE -ne 0) { throw 'Real AWS smoke failed. Inspect the recorded run before continuing.' }
Write-Output "Console deployed: $($web.SiteUrl)"
