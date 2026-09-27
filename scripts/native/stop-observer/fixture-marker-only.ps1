#requires -Version 5.1
param([string]$RequestPath,[string]$CaseDirectory,[string]$ReadHandle,[string]$WriteHandle)
[IO.File]::WriteAllText([IO.Path]::Combine($CaseDirectory,'marker-only.entered'),[Environment]::CommandLine)
