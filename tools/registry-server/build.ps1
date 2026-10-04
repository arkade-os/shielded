$ErrorActionPreference = 'Stop'

Push-Location (Resolve-Path ..\..)
try {
    npm run registry:build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run test:registry
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
