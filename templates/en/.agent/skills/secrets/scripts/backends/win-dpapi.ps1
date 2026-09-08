param()

$ErrorActionPreference = "Stop"

function Write-Result($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
}

function Fail($Code) {
  Write-Result @{ ok = $false; error = $Code }
  exit 1
}

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { Fail "missing_payload" }
try { $payload = $raw | ConvertFrom-Json } catch { Fail "invalid_payload" }

$ref = [string]$payload.ref
$action = [string]$payload.action
if ([string]::IsNullOrWhiteSpace($ref) -or [string]::IsNullOrWhiteSpace($action)) { Fail "missing_action_or_ref" }

$root = $env:CORTEX_SECRET_DIR
if ([string]::IsNullOrWhiteSpace($root)) {
  $root = Join-Path $env:LOCALAPPDATA "cortex-agent\secrets"
}
$safeRef = $ref -replace '[\\/:*?"<>| ]', '_'
$file = Join-Path $root "$safeRef.dpapi"

function Read-Secret($Path) {
  $ciphertext = [System.IO.File]::ReadAllText($Path)
  $secure = ConvertTo-SecureString -String $ciphertext
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

switch ($action) {
  "get" {
    if (-not [System.IO.File]::Exists($file)) { Fail "not_found" }
    try {
      $value = Read-Secret $file
      Write-Result @{ ok = $true; action = "get"; ref = $ref; value = $value }
    } catch { Fail "dpapi_decrypt_failed" }
  }
  "store" {
    $value = [string]$payload.value
    if ([string]::IsNullOrEmpty($value)) { Fail "missing_value_for_store" }
    try {
      [System.IO.Directory]::CreateDirectory($root) | Out-Null
      $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
      $ciphertext = ConvertFrom-SecureString -SecureString $secure
      [System.IO.File]::WriteAllText($file, $ciphertext, [System.Text.UTF8Encoding]::new($false))
      Write-Result @{ ok = $true; action = "store"; ref = $ref; file = $file }
    } catch { Fail "dpapi_encrypt_failed" }
  }
  "rotate" {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    Write-Result @{ ok = $true; action = "rotate"; ref = $ref; file = $file }
  }
  "delete" {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    Write-Result @{ ok = $true; action = "delete"; ref = $ref; file = $file }
  }
  default { Fail "unknown_action" }
}
