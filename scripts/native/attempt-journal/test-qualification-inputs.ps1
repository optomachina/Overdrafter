#requires -Version 5.1
# Exercise the actual shared input producer with real disposable JSON files.
# No Windows runtime, process, credential store or network action is used.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-native-call.ps1')
. (Join-Path $PSScriptRoot 'QualificationInputs.ps1')
$script:checks=0
$root=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($root)
try {
    # Match Measure-PreparedPackage's actual return representation, not a
    # pre-parsed fixture: it constructs one ordered dictionary per file.
    $files=@($PreparedFiles | ForEach-Object {[ordered]@{path=$_.path;bytes=$_.bytes;sha256=$_.sha256}})
    $first=New-PreparedQualificationInputs $root $files $binding.organizationId $binding.projectId $source
    Check ($first.job -is [pscustomobject] -and $first.job.createdAt -is [string]) 'producer returns a strict timestamp-preserving wire object'
    Assert-PreparedQualificationScope $first.job $first.binding $source
    Check $true 'actual produced job passes the original synthetic scope contract'
    $jobBytes=Read-PreparedJson $first.jobPath; $contextBytes=Read-PreparedJson $first.contextPath
    $context=ConvertFrom-CompanionJson ([Text.Encoding]::UTF8.GetString($contextBytes.bytes))
    Assert-CumulativeBinding $first.job $context $contextBytes.sha256
    Check ($jobBytes.sha256 -ceq $first.binding.jobSha256 -and $contextBytes.sha256 -ceq $first.job.contextSha256) 'job and context bind exact on-disk digests'
    $parsedJob=ConvertFrom-CompanionJson ([Text.Encoding]::UTF8.GetString($jobBytes.bytes))
    $parsedBinding=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($first.bindingPath))
    Check ((ConvertTo-JournalJson $parsedJob) -ceq (ConvertTo-JournalJson $first.job)) 'callback consumes the same job as the worker'
    Check ((ConvertTo-JournalJson $parsedBinding) -ceq (ConvertTo-JournalJson $first.binding)) 'worker receives the same binding as the controller'
    $construction=[ordered]@{}; foreach($p in $parsedJob.PSObject.Properties){$construction[$p.Name]=$p.Value}
    Deny { Assert-PreparedQualificationScope $construction $first.binding $source } 'construction dictionaries are still rejected by strict wire validation'
    Deny { New-PreparedQualificationInputs $root $files $binding.organizationId $binding.projectId $source } 'existing scenario cannot overwrite serialized inputs'
    Check ((Read-PreparedJson $first.jobPath).sha256 -ceq $jobBytes.sha256 -and
        (Read-PreparedJson $first.contextPath).sha256 -ceq $contextBytes.sha256) 'failed reuse preserves original bytes'
    $secondRoot=Join-Path $root 'second'; [void][IO.Directory]::CreateDirectory($secondRoot)
    $second=New-PreparedQualificationInputs $secondRoot $first.job.inputFiles $binding.organizationId $binding.projectId $source
    Check ($second.job.attemptId -cne $first.job.attemptId -and $second.job.jobId -cne $first.job.jobId -and
        $second.binding.workerId -cne $first.binding.workerId) 'separate case has separate attempt and worker identities'
    foreach($scenario in @('source','organization','project','files','wrapped_files','extra_property')) {
        $empty=Join-Path $root $scenario; [void][IO.Directory]::CreateDirectory($empty)
        $sourceLabel=$source; $organization=$binding.organizationId; $project=$binding.projectId; $inputs=Copy-JournalFixture $first.job.inputFiles
        switch($scenario) {
            source { $sourceLabel='not-a-commit' }
            organization { $organization='not-an-organization' }
            project { $project='not-a-project' }
            files { $inputs[0].sha256='f'*64 }
            wrapped_files { $inputs=[pscustomobject]@{value=$inputs;Count=3} }
            extra_property { $inputs[0] | Add-Member unexpected 'must-not-be-dropped' }
        }
        Deny { New-PreparedQualificationInputs $empty $inputs $organization $project $sourceLabel } ('reject invalid input '+$scenario)
        Check ([IO.Directory]::GetFiles($empty).Length -eq 0) ('invalid scope creates no files '+$scenario)
    }
    foreach($entrypoint in @('qualify-native-call.ps1','qualify-worker-crash.ps1')) {
        $tokens=$null; $errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $entrypoint),[ref]$tokens,[ref]$errors)
        $calls=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'New-PreparedQualificationInputs'},$true))
        Check ($errors.Count -eq 0 -and $calls.Count -eq 1) ('entrypoint uses the tested shared input producer '+$entrypoint)
    }
} finally { [IO.Directory]::Delete($root,$true) }
[pscustomobject]@{schema='overdrafter.qualification-input-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;storage='disposable JSON files'} | ConvertTo-Json -Compress
