using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Renci.SshNet;

namespace Dorham.Monitor;

public sealed class ConnectionProfile
{
    public string Host { get; set; } = "45.135.242.146";
    public int Port { get; set; } = 22;
    public string Username { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public string ProtectedPassword { get; set; } = "";
    public int IntervalSeconds { get; set; } = 3;
    public bool Alerts { get; set; } = true;
    public bool AutoConnect { get; set; } = true;
    [System.Text.Json.Serialization.JsonIgnore]
    public string Password => string.IsNullOrEmpty(ProtectedPassword) ? "" : Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(ProtectedPassword), null, DataProtectionScope.CurrentUser));
    public void SetPassword(string value) => ProtectedPassword = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(Host) || Host.Any(char.IsWhiteSpace) || Port is < 1 or > 65535 || string.IsNullOrWhiteSpace(Username))
            throw new InvalidOperationException("Enter a server address, SSH port and username.");
        var fingerprint = Fingerprint.Replace("SHA256:", "", StringComparison.OrdinalIgnoreCase).Trim().TrimEnd('=');
        try { if (Convert.FromBase64String(fingerprint + "=").Length != 32) throw new FormatException(); }
        catch (FormatException) { throw new InvalidOperationException("Enter the server's SHA256 host-key fingerprint (43 base64 characters)."); }
        if (string.IsNullOrEmpty(Password)) throw new InvalidOperationException("Enter the SSH password.");
        if (IntervalSeconds is < 2 or > 60) throw new InvalidOperationException("Refresh interval must be from 2 to 60 seconds.");
    }
}

public static class Profiles
{
    public static readonly string DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Dorham Monitor");
    public static string FilePath => Path.Combine(DirectoryPath, "connection.json");
    public static ConnectionProfile Load() => File.Exists(FilePath) ? JsonSerializer.Deserialize<ConnectionProfile>(File.ReadAllText(FilePath)) ?? new() : new();
    public static void Save(ConnectionProfile profile)
    {
        profile.Validate();
        Directory.CreateDirectory(DirectoryPath);
        // Serialize only the protected value; the computed plaintext property is never saved.
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { profile.Host, profile.Port, profile.Username, profile.Fingerprint, profile.ProtectedPassword, profile.IntervalSeconds, profile.Alerts, profile.AutoConnect }, new JsonSerializerOptions { WriteIndented = true });
        var temporary = FilePath + ".new";
        File.WriteAllBytes(temporary, bytes);
        File.Move(temporary, FilePath, true);
    }
}

public sealed record NetworkCounters(string Interface, long Rx, long Tx);
public sealed record ServiceReading(string Name, string State, long? Memory, long? CpuNs);
public sealed record TrafficReading(string? MeasuredAt, long IncomingMeasuredBytes, long AccountingReserveBytes, long QuotaBytes, long EstimatedRemainingBytes, double UsedPercent, long ProjectedPeriodBytes, string? Level);
public sealed record Reading(double Time, string BootId, string Host, int Cores, double Uptime, long CpuTotal, long CpuIdle, double Load, long MemoryTotal, long MemoryAvailable, long SwapTotal, long SwapFree, long DiskTotal, long DiskUsed, long DiskAvailable, NetworkCounters? Network, List<ServiceReading> Services, TrafficReading? Traffic);
public sealed record Rates(double? Cpu, double? Download, double? Upload)
{
    public static Rates Between(Reading? before, Reading now)
    {
        if (before == null || before.BootId != now.BootId || now.Time <= before.Time) return new(null, null, null);
        long total = now.CpuTotal - before.CpuTotal, idle = now.CpuIdle - before.CpuIdle;
        double? cpu = total > 0 && idle >= 0 && idle <= total ? Math.Clamp((total - idle) * 100.0 / total, 0, 100) : null;
        double? rx = null, tx = null;
        if (now.Network != null && before.Network != null && now.Network.Interface == before.Network.Interface)
        {
            var seconds = now.Time - before.Time;
            if (now.Network.Rx >= before.Network.Rx) rx = (now.Network.Rx - before.Network.Rx) / seconds;
            if (now.Network.Tx >= before.Network.Tx) tx = (now.Network.Tx - before.Network.Tx) / seconds;
        }
        return new(cpu, rx, tx);
    }
}

public sealed class TelemetryClient : IDisposable
{
    private SshClient? client;
    public bool HostMismatch { get; private set; }
    public void Connect(ConnectionProfile profile)
    {
        profile.Validate();
        Dispose();
        HostMismatch = false;
        var info = new PasswordConnectionInfo(profile.Host, profile.Port, profile.Username, profile.Password) { Timeout = TimeSpan.FromSeconds(12) };
        client = new SshClient(info) { KeepAliveInterval = TimeSpan.FromSeconds(15) };
        var expected = profile.Fingerprint.Replace("SHA256:", "", StringComparison.OrdinalIgnoreCase).Trim().TrimEnd('=');
        client.HostKeyReceived += (_, e) =>
        {
            var actual = Convert.ToBase64String(SHA256.HashData(e.HostKey)).TrimEnd('=');
            e.CanTrust = CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual));
            HostMismatch = !e.CanTrust;
        };
        client.Connect();
    }
    public Reading Read()
    {
        if (client?.IsConnected != true) throw new InvalidOperationException("SSH connection is closed.");
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Dorham.Monitor.collector.py") ?? throw new IOException("Telemetry collector is missing.");
        using var reader = new StreamReader(stream);
        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(reader.ReadToEnd()));
        // The only remote command is an embedded, fixed read-only collector. No user text is interpolated.
        using var command = client.CreateCommand("python3 -c \"import base64;exec(base64.b64decode('" + payload + "'))\"");
        command.CommandTimeout = TimeSpan.FromSeconds(10);
        var output = command.Execute();
        if (command.ExitStatus != 0) throw new IOException("The read-only collector failed. Check Python 3 and /proc access on the server.");
        var reading = JsonSerializer.Deserialize<Reading>(output, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new IOException("No telemetry received.");
        if (reading.MemoryTotal <= 0 || reading.DiskTotal <= 0 || reading.Cores <= 0 || reading.Services == null) throw new IOException("Incomplete server readings.");
        return reading;
    }
    public void Dispose() { client?.Dispose(); client = null; }
}
