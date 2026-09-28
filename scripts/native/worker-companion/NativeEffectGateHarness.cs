using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// Inert Windows test target. Marker stands for a native effect; no CAD loads.
static class NativeEffectGateHarness
{
    static int Main(string[] args)
    {
        try {
            if (args.Length != 4) throw new InvalidOperationException("harness_arguments");
            var json = new JavaScriptSerializer();
            var settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0]));
            var gate = new NativeEffectGate(settings);
            int checks = Int32.Parse(args[3]);
            if (checks < 1 || checks > 2) throw new InvalidOperationException("harness_checks");
            for (int i = 0; i < checks; i++) gate.Check(args[1]);
            File.WriteAllText(args[2], "native-effect-marker");
            Console.WriteLine("{\"outcome\":\"passed\"}");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 2;
        }
    }
}
