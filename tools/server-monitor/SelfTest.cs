using System.IO;
using System.Text.Json;

namespace Dorham.Monitor;

public static class SelfTest
{
    public static async Task Run(string? output)
    {
        int passed = 0;
        void Assert(bool ok, string name) { if (!ok) throw new InvalidOperationException("Check failed: " + name); passed++; }
        Reading Make(double time, long total, long idle, string boot = "boot-a", long rx = 100, long tx = 200) => new(time, boot, "fixture", 1, 100, total, idle, 0, 2000, 1000, 0, 0, 10000, 2000, 8000, new("eth0", rx, tx), [], null);
        var first = Make(10, 1000, 500);
        var second = Make(12, 1200, 650, rx: 2148, tx: 4296);
        var rates = Rates.Between(first, second);
        Assert(rates.Cpu == 25, "CPU excludes idle, uses counter delta");
        Assert(rates.Download == 1024 && rates.Upload == 2048, "network bytes per second");
        Assert(Rates.Between(null, second).Cpu == null, "first CPU is unknown");
        Assert(Rates.Between(first, second with { BootId = "reboot" }).Download == null, "reboot resets rates");
        Assert(Rates.Between(second, first).Cpu == null, "nonpositive elapsed time rejected");
        Assert(Rates.Between(first, second with { CpuTotal = 900 }).Cpu == null, "CPU reset rejected");
        Assert(Rates.Between(first, second with { CpuIdle = 900 }).Cpu == null, "impossible idle delta rejected");
        Assert(Rates.Between(first, second with { Network = new("eth0", 0, 0) }).Download == null, "network counter reset rejected");
        Assert(Rates.Between(first, second with { Network = new("ens3", 500, 700) }).Upload == null, "interface changes reset rates");
        Assert(Rates.Between(first, second with { Network = null }).Download == null, "unavailable network remains unknown");
        var profile = new ConnectionProfile { Host = "example.test", Username = "operator", Fingerprint = new string('A', 43) };
        profile.SetPassword("local-fixture-never-a-real-secret"); profile.Validate();
        Assert(profile.Password == "local-fixture-never-a-real-secret", "Windows DPAPI round trip");
        Assert(!profile.ProtectedPassword.Contains("local-fixture"), "stored secret is encrypted");
        bool bad = false;
        profile.Fingerprint = "";
        try { profile.Validate(); } catch (InvalidOperationException) { bad = true; }
        Assert(bad, "missing fingerprint rejected");
        profile.Fingerprint = new string('A', 43); profile.IntervalSeconds = 0; bad = false;
        try { profile.Validate(); } catch (InvalidOperationException) { bad = true; }
        Assert(bad, "unbounded polling rejected");
        Assert(Format.Bytes(1073741824) == "1.0 GiB", "binary memory units");
        Assert(Format.Rate(null) == "—", "unknown never rendered as zero");
        int adminPassed = await AdminSelfTest.Run();
        var window = new MainWindow(new ConnectionProfile { AutoConnect = false });
        try
        {
            var expected = $"Dorham Monitor {typeof(MainWindow).Assembly.GetName().Version?.ToString(3)}";
            Assert(window.Title == expected && window.FindName("VersionLabel") is System.Windows.Controls.TextBlock label && label.Text == expected, "window version matches assembly");
            ((System.Windows.Controls.Button)window.FindName("UsersNav")).RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            await ((AdminPanel)window.FindName("Admin")).VerifyFeatureAccess(output == null ? null : () =>
            {
                var visual = (System.Windows.FrameworkElement)window.Content;
                var size = new System.Windows.Size(window.Width, window.Height);
                visual.Measure(size);
                visual.Arrange(new System.Windows.Rect(size));
                window.Capture(Path.ChangeExtension(output, ".people.png"));
            });
            adminPassed++;
        }
        finally { window.Close(); }
        if (output != null) File.WriteAllText(output, JsonSerializer.Serialize(new { passed, adminPassed, status = "passed", at = DateTimeOffset.UtcNow }, new JsonSerializerOptions { WriteIndented = true }));
    }
}
