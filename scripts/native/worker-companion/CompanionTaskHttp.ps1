#requires -Version 5.1
# Purpose-bound task endpoint; no arbitrary URL, redirect, proxy or credentials in logs.
Set-StrictMode -Version Latest
function Send-CompanionTaskHttp($Request,[string]$Token,[string]$Url) {
    Assert-CompanionWindows
    if ($Request.schema -cne 'overdrafter.worker-task.v1' -or
        $Request.action -cnotin @('claim','eligibility','heartbeat') -or
        $Token -cnotmatch '^odw_[0-9a-f]{64}$') { throw 'Invalid task transport input.' }
    $uri=$null
    if (-not [Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -cne 'https' -or
        $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.AbsolutePath -cne '/functions/v1/engineering-worker-task') { throw 'Invalid task endpoint.' }
    $json=$Request | ConvertTo-Json -Depth 12 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 2048) { throw 'Task request exceeds bound.' }
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false; $handler.UseProxy=$false
    $handler.AutomaticDecompression=[Net.DecompressionMethods]::None
    $client=New-Object Net.Http.HttpClient($handler,$true)
    $cancel=New-Object Threading.CancellationTokenSource
    $message=$null; $response=$null; $stream=$null
    try {
        $cancel.CancelAfter(5000)
        $message=New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post,$Url)
        $message.Headers.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$Token)
        $message.Content=New-Object Net.Http.StringContent($json,[Text.Encoding]::UTF8,'application/json')
        $send=$client.SendAsync($message,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token)
        $send.Wait($cancel.Token); $response=$send.GetAwaiter().GetResult()
        if ($response.Headers.Location -or $null -eq $response.Content.Headers.ContentType -or
            $response.Content.Headers.ContentType.MediaType -cne 'application/json' -or
            $response.Content.Headers.ContentEncoding.Count -ne 0 -or $response.Content.Headers.ContentLength -gt 200000) {
            throw 'Unsupported task HTTP response.'
        }
        $open=$response.Content.ReadAsStreamAsync(); $open.Wait($cancel.Token); $stream=$open.GetAwaiter().GetResult()
        $buffer=New-Object byte[] 4096; $memory=New-Object IO.MemoryStream
        try {
            while ($true) {
                $read=$stream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token)
                $read.Wait($cancel.Token); $count=$read.GetAwaiter().GetResult()
                if ($count -eq 0) { break }
                if ($memory.Length+$count -gt 200000) { throw 'Task HTTP response exceeds bound.' }
                $memory.Write($buffer,0,$count)
            }
            $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($memory.ToArray())
            return [pscustomobject]@{status=[int]$response.StatusCode;body=(ConvertFrom-CompanionJson $text)}
        } finally { $memory.Dispose() }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $message) { $message.Dispose() }
        $cancel.Dispose(); $client.Dispose()
    }
}
