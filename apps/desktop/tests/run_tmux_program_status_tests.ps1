# Run the production Rust parser tests independently when unrelated Unix-only
# crate tests do not compile on Windows. Build dependencies with cargo check/test
# first; this runner reuses the workspace's compiled serde libraries.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$collectorBackend = (Resolve-Path (Join-Path $PSScriptRoot '../src-tauri')).Path
$collectorModule = Join-Path $collectorBackend 'src/tmux_program_status.rs'
$collectorDeps = Join-Path $collectorBackend 'target/debug/deps'
$collectorSource = Get-Content -LiteralPath $collectorModule -Raw
$collectorCommandOffset = $collectorSource.IndexOf('#[tauri::command]')
$collectorTestsOffset = $collectorSource.IndexOf('#[cfg(test)]')
if ($collectorCommandOffset -lt 0 -or $collectorTestsOffset -le $collectorCommandOffset) {
    throw 'Cannot identify the production parser and its original test module.'
}
# Keep every parser declaration and the original tests; only the IPC wrapper and
# its imports are omitted. cargo check --lib still checks that wrapper separately.
$collectorSource = $collectorSource.Substring(0, $collectorCommandOffset) + $collectorSource.Substring($collectorTestsOffset)
$collectorSource = $collectorSource.Replace('use crate::{local_shell::LocalState, ssh::SshState, tmux::execute_session};', '')
$collectorSource = $collectorSource.Replace('use tauri::State;', '')
$collectorSource = $collectorSource.Replace('use std::{collections::HashSet, time::Duration};', 'use std::collections::HashSet;')
$collectorSerde = Get-ChildItem -LiteralPath $collectorDeps -File |
    Where-Object { $_.Name -match '^libserde-.*\.rlib$' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$collectorJson = Get-ChildItem -LiteralPath $collectorDeps -File |
    Where-Object { $_.Name -match '^libserde_json-.*\.rlib$' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$collectorSerde -or !$collectorJson) {
    throw 'Compiled serde libraries are missing from src-tauri/target/debug/deps.'
}
$collectorHarnessDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dssh-tmux-collector-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $collectorHarnessDir | Out-Null
$collectorHarnessSource = Join-Path $collectorHarnessDir 'collector_tests.rs'
Set-Content -LiteralPath $collectorHarnessSource -Value $collectorSource -Encoding utf8
$collectorPreviousManifestDir = $env:CARGO_MANIFEST_DIR
try {
    $env:CARGO_MANIFEST_DIR = $collectorBackend
    & rustc --test --edition=2021 $collectorHarnessSource `
        --extern ('serde=' + $collectorSerde.FullName) `
        --extern ('serde_json=' + $collectorJson.FullName) `
        -L ('dependency=' + $collectorDeps) --out-dir $collectorHarnessDir
    if ($LASTEXITCODE -ne 0) { throw 'Rust parser test harness compilation failed.' }
    $collectorExecutable = Join-Path $collectorHarnessDir 'collector_tests.exe'
    if (!(Test-Path -LiteralPath $collectorExecutable)) {
        $collectorExecutable = Join-Path $collectorHarnessDir 'collector_tests'
    }
    & $collectorExecutable --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'Rust parser tests failed.' }
    Write-Output ('Preserved test harness: ' + $collectorHarnessDir)
    Get-FileHash -LiteralPath $collectorModule -Algorithm SHA256
} finally {
    $env:CARGO_MANIFEST_DIR = $collectorPreviousManifestDir
}
