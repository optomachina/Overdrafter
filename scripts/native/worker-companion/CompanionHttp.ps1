#requires -Version 5.1
# Outbound HTTPS only; no redirect, cookie, proxy, file or CAD capability.
Set-StrictMode -Version Latest
function Read-CompanionHttpBody($Stream,[Threading.CancellationToken]$CancellationToken) {
    $buffer=New-Object byte[] 4096; $memory=New-Object IO.MemoryStream
    try {
        while ($true) {
            $read=$Stream.ReadAsync($buffer,0,$buffer.Length,$CancellationToken)
            $read.Wait($CancellationToken); $count=$read.GetAwaiter().GetResult()
            if ($count -eq 0) { break }
            if ($memory.Length+$count -gt 32768) { throw 'Companion HTTP response is too large.' }
            $memory.Write($buffer,0,$count)
        }
        $encoding=New-Object Text.UTF8Encoding($false,$true)
        return $encoding.GetString($memory.ToArray())
    } finally { $memory.Dispose() }
}
function Send-CompanionHttp($Request,[string]$Token,[string]$GatewayUrl) {
    Assert-CompanionWindows; Assert-CompanionEndpoint $GatewayUrl
    if ($Token -cnotmatch '^odw_[0-9a-f]{64}$') { throw 'Invalid companion token.' }
    $json=$Request | ConvertTo-Json -Depth 20 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) { throw 'Companion request is too large.' }
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false; $handler.UseProxy=$false
    $handler.AutomaticDecompression=[Net.DecompressionMethods]::None
    $client=New-Object Net.Http.HttpClient($handler,$true)
    $cancel=New-Object Threading.CancellationTokenSource
    $message=$null; $response=$null; $stream=$null
    try {
        $cancel.CancelAfter(5000)
        $message=New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post,$GatewayUrl)
        $message.Headers.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$Token)
        $message.Content=New-Object Net.Http.StringContent($json,[Text.Encoding]::UTF8,'application/json')
        $send=$client.SendAsync($message,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token)
        $send.Wait($cancel.Token); $response=$send.GetAwaiter().GetResult()
        if ($null -eq $response.Content.Headers.ContentType -or $response.Content.Headers.ContentType.MediaType -cne 'application/json' -or
            $response.Content.Headers.ContentEncoding.Count -ne 0 -or $response.Content.Headers.ContentLength -gt 32768) {
            throw 'Unsupported companion HTTP response.'
        }
        $open=$response.Content.ReadAsStreamAsync(); $open.Wait($cancel.Token); $stream=$open.GetAwaiter().GetResult()
        $body=ConvertFrom-CompanionJson (Read-CompanionHttpBody $stream $cancel.Token)
        return [pscustomobject]@{status=[int]$response.StatusCode;body=$body}
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $message) { $message.Dispose() }
        $cancel.Dispose(); $client.Dispose()
    }
}
