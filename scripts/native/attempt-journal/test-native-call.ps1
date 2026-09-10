#requires -Version 5.1
# Inert receipt validation; real COM notifications still require Windows cases.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-checkpoint.ps1')
. (Join-Path $PSScriptRoot 'NativeCallEvidence.ps1')
$script:checks=0
$source='a'*40; $attempt='C:\Private\'+$job.attemptId
$settings=[pscustomobject]@{candidateRoot=($attempt+'\candidate');jobId=$job.jobId;attemptId=$job.attemptId;
    requestSha256=$binding.jobSha256;contextSha256=$job.contextSha256;expectedDepthMm=5;depthMm=8;
    inputFiles=$job.inputFiles;qualificationBoundary='open_call';qualificationSourceCommit=$source;qualificationNonce=(Id 909)}
$progress=[pscustomobject]@{jobId=$job.jobId;attemptId=$job.attemptId;requestSha256=$binding.jobSha256;
    sourceCommit=$source;stage='native_dimension';binaries=[pscustomobject]@{PreparedDimensionProbe=('b'*64)};
    native=[pscustomobject]@{pid=303;ticks='639246383990000000';session=1}}
$receipt=[pscustomobject]@{schema='overdrafter.native-call-checkpoint.v1';phase='entered';boundary='open_call';
    sourceCommit=$source;nonce=$settings.qualificationNonce;jobId=$job.jobId;attemptId=$job.attemptId;
    requestSha256=$binding.jobSha256;contextSha256=$job.contextSha256;eventName='FileOpenPreNotify';
    path=($attempt+'\candidate\parts\baseline-5mm.SLDPRT');candidateRoot=$settings.candidateRoot;pauseMs=60000;
    helperPid=304;helperCreationTicks='639246383991000000';sessionId=1;helperPath=($attempt+'\PreparedDimensionProbe.exe');
    helperSha256=('b'*64);nativePid=303;nativeCreationTicks=$progress.native.ticks;
    nativePath='C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe';
    nativeSha256='6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc';utc='2026-09-10T12:01:00.0000000Z'}
foreach ($boundary in @('open_call','part_save_call','assembly_save_call')) {
    $copy=Copy-JournalFixture $receipt; $options=Copy-JournalFixture $settings
    $copy.boundary=$boundary; $options.qualificationBoundary=$boundary
    if ($boundary -ceq 'part_save_call') { $copy.eventName='Part.FileSaveNotify' }
    if ($boundary -ceq 'assembly_save_call') { $copy.eventName='Assembly.FileSaveNotify'; $copy.path=$attempt+'\candidate\synthetic-assembly.SLDASM' }
    Assert-PreparedNativeCallCheckpoint $copy $job $binding $options $progress $owner $source $attempt
    Check $true ('exact native call scope '+$boundary)
    Deny { $bad=Copy-JournalFixture $copy; $bad.eventName='FileOpenNotify2'; Assert-PreparedNativeCallCheckpoint $bad $job $binding $options $progress $owner $source $attempt } ('post-notify cannot substitute '+$boundary)
}
foreach ($field in @('schema','phase','boundary','sourceCommit','nonce','jobId','attemptId','requestSha256',
    'contextSha256','eventName','path','candidateRoot','helperPath','helperSha256','nativePath','nativeSha256','utc')) {
    Deny { $bad=Copy-JournalFixture $receipt; $bad.$field='other'; Assert-PreparedNativeCallCheckpoint $bad $job $binding $settings $progress $owner $source $attempt } ('changed receipt '+$field)
    Deny { $bad=Copy-JournalFixture $receipt; $bad.$field=@($bad.$field); Assert-PreparedNativeCallCheckpoint $bad $job $binding $settings $progress $owner $source $attempt } ('array text '+$field)
}
foreach ($case in @('owner','pid_alias','native_pid','native_ticks','helper_before_native','other_session',
    'pause_string','short_pause','array_pid','observation_before_helper','extra_authority')) {
    Deny {
        $bad=Copy-JournalFixture $receipt
        switch ($case) {
            owner { $bad.helperPid=$owner.pid }
            pid_alias { $bad.helperPid=$bad.nativePid }
            native_pid { $bad.nativePid=305 }
            native_ticks { $bad.nativeCreationTicks='639246383990000001' }
            helper_before_native { $bad.helperCreationTicks='639246383989000000' }
            other_session { $bad.sessionId=2 }
            pause_string { $bad.pauseMs='60000' }
            short_pause { $bad.pauseMs=10 }
            array_pid { $bad.helperPid=@(304) }
            observation_before_helper { $bad.utc='2020-01-01T00:00:00.0000000Z' }
            extra_authority { $bad | Add-Member retryAuthorized $true }
        }
        Assert-PreparedNativeCallCheckpoint $bad $job $binding $settings $progress $owner $source $attempt
    } ('unsafe native call evidence '+$case)
}
foreach ($field in @('qualificationNonce','qualificationSourceCommit','qualificationBoundary','candidateRoot','contextSha256','jobId','attemptId','requestSha256')) {
    Deny { $bad=Copy-JournalFixture $settings; $bad.$field='other'; Assert-PreparedNativeCallCheckpoint $receipt $job $binding $bad $progress $owner $source $attempt } ('changed settings '+$field)
}
foreach ($field in @('sourceCommit','stage','jobId','attemptId','requestSha256')) {
    Deny { $bad=Copy-JournalFixture $progress; $bad.$field='other'; Assert-PreparedNativeCallCheckpoint $receipt $job $binding $settings $bad $owner $source $attempt } ('changed progress '+$field)
}
Deny { Assert-PreparedNativeCallCheckpoint $receipt $job $binding $settings $progress $owner $source 'C:\Elsewhere' } 'foreign attempt root'
Deny { $bad=Copy-JournalFixture $job; $bad.depthMm=9; Assert-PreparedNativeCallCheckpoint $receipt $bad $binding $settings $progress $owner $source $attempt } 'different native operation'
foreach ($field in @('depthMm','expectedDepthMm')) {
    Deny { $bad=Copy-JournalFixture $settings; $bad.$field=[string]$bad.$field; Assert-PreparedNativeCallCheckpoint $receipt $job $binding $bad $progress $owner $source $attempt } ('string quantity '+$field)
}
$interrupted=$base
$nativeIntent=Intent 3 native $null
$nativeIntent.executablePath=$receipt.nativePath; $nativeIntent.executableSha256=$receipt.nativeSha256
$nativeStarted=Started 3 $receipt.nativePid
$nativeStarted.creationTicks=$receipt.nativeCreationTicks; $nativeStarted.executablePath=$receipt.nativePath
$nativeStarted.executableSha256=$receipt.nativeSha256
$interrupted=Event $interrupted launch_intent $nativeIntent
$interrupted=Event $interrupted process_started $nativeStarted
$interrupted=Event $interrupted phase ([pscustomobject]@{phase='startup_wait'})
$interrupted=Event $interrupted phase ([pscustomobject]@{phase='startup_ready'})
$interrupted=Event $interrupted phase ([pscustomobject]@{phase='operation_started'})
$helperIntent=Intent 4 operation $null
$helperIntent.executablePath=$receipt.helperPath; $helperIntent.executableSha256=$receipt.helperSha256
$helperStarted=Started 4 $receipt.helperPid
$helperStarted.creationTicks=$receipt.helperCreationTicks; $helperStarted.executablePath=$receipt.helperPath
$helperStarted.executableSha256=$receipt.helperSha256
$interrupted=Event $interrupted launch_intent $helperIntent
$interrupted=Event $interrupted process_started $helperStarted
Assert-NativeCallInterruptedJournal $interrupted $binding $receipt
Check $true 'interrupted history binds both active processes without repair'
foreach ($field in @('nativePid','helperPid','nativeCreationTicks','helperCreationTicks','nativePath','helperPath','nativeSha256','helperSha256','sessionId')) {
    Deny {
        $bad=Copy-JournalFixture $receipt
        if ($field -in @('nativePid','helperPid','sessionId')) { $bad.$field=999 }
        else { $bad.$field='different' }
        Assert-NativeCallInterruptedJournal $interrupted $binding $bad
    } ('journal rejects substituted process '+$field)
}
Deny { Assert-NativeCallInterruptedJournal $saved $binding $receipt } 'completed operation cannot substitute for interrupted history'
Deny { $bad=Copy-JournalFixture $binding; $bad.bootId=Id 990; Assert-NativeCallInterruptedJournal $interrupted $bad $receipt } 'other journal binding rejected'
$failureHistory=Event $interrupted failure ([pscustomobject]@{code='native_operation_failed';evidenceSha256=('f'*64)})
Deny { Assert-NativeCallInterruptedJournal $failureHistory $binding $receipt } 'later failure history does not claim unchanged interruption'
[pscustomobject]@{schema='overdrafter.native-call-evidence-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0} | ConvertTo-Json -Compress
