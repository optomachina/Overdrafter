using System;
using System.IO;
using System.Threading.Tasks;

public sealed class FixturePipeReceipt {
    public string Text;
    public long EofTicks;
    public static async Task<FixturePipeReceipt> Read(StreamReader reader, string releasePath) {
        string text=await reader.ReadToEndAsync().ConfigureAwait(false);
        if (!String.IsNullOrEmpty(releasePath)) File.WriteAllText(releasePath,"authority-eof-observed");
        return new FixturePipeReceipt { Text=text, EofTicks=DateTime.UtcNow.Ticks };
    }
}
