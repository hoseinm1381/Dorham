using System.IO;
using System.Text.Json;
using System.Windows;

namespace Dorham.Monitor;

public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            if (e.Args.FirstOrDefault() == "--configure" && e.Args.Length == 3)
            {
                // Explicit local bootstrap. Only the DPAPI-encrypted password is persisted.
                using var document = JsonDocument.Parse(File.ReadAllText(e.Args[1]));
                var root = document.RootElement;
                var p = new ConnectionProfile { Host = root.GetProperty("host").GetString()!, Username = root.GetProperty("username").GetString()!, Fingerprint = e.Args[2] };
                p.SetPassword(root.GetProperty("password").GetString()!); Profiles.Save(p); Shutdown(); return;
            }
            if (e.Args.FirstOrDefault() == "--self-test") { ShutdownMode = ShutdownMode.OnExplicitShutdown; await SelfTest.Run(e.Args.ElementAtOrDefault(1)); Shutdown(); return; }
            if (e.Args.FirstOrDefault() == "--admin-ui-test" && e.Args.Length == 2)
            {
                Directory.CreateDirectory(e.Args[1]);
                var preview = new MainWindow(new ConnectionProfile { AutoConnect = false }); MainWindow = preview; preview.Show();
                await preview.CaptureAdminPreview(e.Args[1]); preview.Close(); return;
            }
            var profile = Profiles.Load();
            if (e.Args.FirstOrDefault() == "--probe" && e.Args.Length == 2)
            {
                using var client = new TelemetryClient();
                await Task.Run(() => client.Connect(profile));
                var first = await Task.Run(client.Read); await Task.Delay(2200);
                var second = await Task.Run(client.Read);
                var rates = Rates.Between(first, second);
                if (rates.Cpu == null || rates.Download == null || rates.Upload == null || second.Services.Count < 4) throw new InvalidOperationException("Live telemetry was incomplete.");
                // Also prove an incorrect host key is rejected by the real SSH handshake.
                var wrong = Profiles.Load(); wrong.Fingerprint = new string('A', 43);
                using var reject = new TelemetryClient();
                bool rejected = false;
                try { await Task.Run(() => reject.Connect(wrong)); } catch { rejected = reject.HostMismatch; }
                if (!rejected) throw new InvalidOperationException("Host-key rejection check failed.");
                File.WriteAllText(e.Args[1], JsonSerializer.Serialize(new { capturedAt = DateTimeOffset.UtcNow, reading = second, rates, wrongHostKeyRejected = rejected }, new JsonSerializerOptions { WriteIndented = true }));
                Shutdown(); return;
            }
            var window = new MainWindow(profile); MainWindow = window; window.Show();
            if (e.Args.FirstOrDefault() == "--ui-test" && e.Args.Length == 2)
            {
                await window.ExerciseUi(e.Args[1]); window.Close(); return;
            }
            if (e.Args.FirstOrDefault() == "--capture" && e.Args.Length == 2)
            {
                for (int i = 0; i < 60 && window.SampleCount < 5; i++) await Task.Delay(1000);
                if (window.SampleCount < 5) throw new InvalidOperationException("Not enough live readings for a screenshot.");
                window.Capture(e.Args[1]); window.Close();
            }
        }
        catch (Exception error)
        {
            if (e.Args.Length > 0)
            {
                Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
                try
                {
                    Directory.CreateDirectory(Profiles.DirectoryPath);
                    File.WriteAllText(Path.Combine(Profiles.DirectoryPath, "last-error.txt"), error.GetType().Name + ": " + error.Message);
                }
                catch (Exception loggingError) when (loggingError is IOException or UnauthorizedAccessException) { /* A diagnostic must not crash when the profile is read-only. */ }
                Shutdown(1);
            }
            else
            {
                MessageBox.Show("Dorham Monitor could not load the saved connection. Open Connection settings to enter it again.\n\n" + error.Message, "Dorham Monitor", MessageBoxButton.OK, MessageBoxImage.Information);
                var window = new MainWindow(new ConnectionProfile()); MainWindow = window; window.Show();
            }
        }
    }
}
