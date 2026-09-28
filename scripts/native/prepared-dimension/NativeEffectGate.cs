using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Cooperative gate for the connected PreparedDimensionProbe only. This has no
// network credential and does not stop a SolidWorks call already in progress.
// The directly owning runner relays each request to the companion, which
// obtains fresh server eligibility before returning a one-use release.
sealed class NativeEffectGate
{
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192 };
    readonly string taskId, attemptId, deadlineText, authorityPath;
    readonly long fence;
    readonly DateTimeOffset deadline;
    readonly StreamReader input;
    long index;
    long revision;
    string launchId;

    public NativeEffectGate(Dictionary<string, object> settings)
    {
        taskId = Text(settings, "taskId");
        attemptId = Text(settings, "attemptId");
        deadlineText = Text(settings, "deadlineAt");
        authorityPath = Text(settings, "authorityPath");
        fence = Convert.ToInt64(settings["fence"], CultureInfo.InvariantCulture);
        Guid parsedId;
        DateTimeOffset parsedDeadline;
        if (!Guid.TryParseExact(taskId, "D", out parsedId) ||
            !Guid.TryParseExact(attemptId, "D", out parsedId) || fence < 1 ||
            !DateTimeOffset.TryParse(deadlineText, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out parsedDeadline) || parsedDeadline <= DateTimeOffset.UtcNow ||
            !Path.IsPathRooted(authorityPath)) throw new InvalidOperationException("native_gate_binding");
        deadline = parsedDeadline;
        input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), true);
    }

    static string Text(Dictionary<string, object> value, string key)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || !(raw is string))
            throw new InvalidOperationException("native_gate_field_" + key);
        return (string)raw;
    }

    static long Integer(Dictionary<string, object> value, string key)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) ||
            (raw is bool) || !(raw is int || raw is long))
            throw new InvalidOperationException("native_gate_integer_" + key);
        return Convert.ToInt64(raw, CultureInfo.InvariantCulture);
    }

    DateTimeOffset Lease()
    {
        if (DateTimeOffset.UtcNow >= deadline || File.Exists(authorityPath + ".revoked"))
            throw new InvalidOperationException("native_gate_deadline_or_revoked");
        string source = File.ReadAllText(authorityPath, new UTF8Encoding(false, true));
        if (Encoding.UTF8.GetByteCount(source) > 2048)
            throw new InvalidOperationException("native_gate_authority_size");
        var record = json.Deserialize<Dictionary<string, object>>(source);
        if (record.Count != 6 || Text(record, "schema") != "overdrafter.companion-task-authority.v1" ||
            Text(record, "attemptId") != attemptId || Integer(record, "fence") != fence ||
            Text(record, "deadlineAt") != deadlineText)
            throw new InvalidOperationException("native_gate_authority_binding");
        DateTimeOffset lease;
        if (!DateTimeOffset.TryParse(Text(record, "leaseExpiresAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.None, out lease) || lease > deadline || lease <= DateTimeOffset.UtcNow)
            throw new InvalidOperationException("native_gate_lease");
        revision = Integer(record, "revision");
        return lease;
    }

    string ReadLine(int milliseconds)
    {
        // Console.In is a synchronized wrapper whose ReadAsync may block before
        // returning a task on .NET Framework. Read on a worker thread instead;
        // the STA control thread enforces the original lease/deadline even if
        // its directly owning parent stays alive but never replies.
        Task<string> pending = Task.Run(() => {
            var line = new StringBuilder();
            bool carriage = false;
            while (line.Length <= 4096) {
                int code = input.Read();
                if (code < 0) throw new InvalidOperationException("native_gate_parent_closed");
                if (code == '\n') return line.ToString();
                if (code == '\r' && !carriage) { carriage = true; continue; }
                if (carriage) throw new InvalidOperationException("native_gate_response_cr");
                line.Append((char)code);
            }
            throw new InvalidOperationException("native_gate_response_size");
        });
        if (!pending.Wait(milliseconds)) throw new InvalidOperationException("native_gate_response_timeout");
        return pending.GetAwaiter().GetResult();
    }

    public void Check(string effect)
    {
        if (String.IsNullOrEmpty(effect) || effect.Length > 80 ||
            !Regex.IsMatch(effect, @"\A[A-Za-z][A-Za-z0-9_.]*\z"))
            throw new InvalidOperationException("native_gate_effect");
        DateTimeOffset lease = Lease();
        if (index == Int64.MaxValue) throw new InvalidOperationException("native_gate_index");
        index++;
        string nonce = Guid.NewGuid().ToString("D");
        int pid;
        string ticks;
        using (Process current = Process.GetCurrentProcess()) {
            pid = current.Id;
            ticks = current.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        }
        Console.Out.WriteLine(json.Serialize(new { schema = "overdrafter.native-effect-authority.v1",
            action = "check", taskId, attemptId, fence, deadlineAt = deadlineText,
            pid, creationTicks = ticks, nonce, index, effect }));
        Console.Out.Flush();
        int wait = (int)Math.Min(30000, Math.Floor(Math.Min(
            (lease - DateTimeOffset.UtcNow).TotalMilliseconds,
            (deadline - DateTimeOffset.UtcNow).TotalMilliseconds)));
        if (wait < 1) throw new InvalidOperationException("native_gate_expired_before_response");
        string text = ReadLine(wait);
        if (Encoding.UTF8.GetByteCount(text) > 4096)
            throw new InvalidOperationException("native_gate_response_size");
        Dictionary<string, object> response;
        try { response = json.Deserialize<Dictionary<string, object>>(text); }
        catch (Exception error) {
            int first = text.Length == 0 ? -1 : (int)text[0];
            throw new InvalidOperationException("native_gate_response_json_length_" +
                text.Length.ToString(CultureInfo.InvariantCulture) + "_first_" +
                first.ToString(CultureInfo.InvariantCulture), error);
        }
        string receivedLaunch = Text(response, "launchId");
        Guid parsedLaunch;
        if (!Guid.TryParseExact(receivedLaunch, "D", out parsedLaunch) ||
            (launchId != null && launchId != receivedLaunch))
            throw new InvalidOperationException("native_gate_launch_binding");
        if (response.Count != 14 || Text(response, "schema") != "overdrafter.native-effect-authority.v1" ||
            Text(response, "action") != "release" || Text(response, "taskId") != taskId ||
            Text(response, "attemptId") != attemptId || Integer(response, "fence") != fence ||
            Text(response, "deadlineAt") != deadlineText || Text(response, "nonce") != nonce ||
            Integer(response, "index") != index || Text(response, "effect") != effect ||
            Integer(response, "pid") != pid || Text(response, "creationTicks") != ticks)
            throw new InvalidOperationException("native_gate_response_binding");
        DateTimeOffset returnedLease;
        if (!DateTimeOffset.TryParse(Text(response, "leaseExpiresAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.None, out returnedLease) || returnedLease <= DateTimeOffset.UtcNow ||
            returnedLease > deadline || returnedLease > Lease() ||
            Integer(response, "revision") > revision || Integer(response, "revision") < 0)
            throw new InvalidOperationException("native_gate_response_lease");
        launchId = receivedLaunch;
    }
}
