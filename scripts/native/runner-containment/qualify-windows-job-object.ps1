#requires -Version 5.1
<#
.SYNOPSIS
Disabled source packet for a future Workstation Job Object qualification.
.DESCRIPTION
The later lane is limited to root-exit, tree-exit, tree-timeout, child-limit,
and fixed journal-fault cases. It must bind exact source/host/runtime hashes,
use one case and at most three helper processes at a time, and preserve private
journal evidence. Schema validity or -Qualify is never authority.
#>
[CmdletBinding()]
param(
    [switch]$Qualify,
    [string]$AdmissionPath,
    [string]$OutputRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

throw 'not_admitted: Windows Job Object qualification requires a later exact admission.'
