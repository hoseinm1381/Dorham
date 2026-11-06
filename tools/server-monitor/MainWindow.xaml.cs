using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Renci.SshNet.Common;

namespace Dorham.Monitor;

public partial class MainWindow : Window
{
    private ConnectionProfile profile;
    private CancellationTokenSource? cancellation;
    private Task? polling;
    private TelemetryClient? session;
    private readonly List<(DateTime Time, double? Cpu, double? Memory, double? Rx, double? Tx)> history = [];
    private bool networkChart;
    private bool closing;
    private DateTime? lastReading;
    private bool isLive;
    private readonly DispatcherTimer clock = new() { Interval = TimeSpan.FromSeconds(1) };
    public int SampleCount { get; private set; }

    public MainWindow(ConnectionProfile loaded)
    {
        profile = loaded;
        InitializeComponent();
        var version = typeof(MainWindow).Assembly.GetName().Version;
        Title = VersionLabel.Text = $"Dorham Monitor {version?.ToString(3)}";
        FillSettings();
        clock.Tick += (_, _) => UpdateAge();
        clock.Start();
        SourceInitialized += (_, _) => { int dark = 1; DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref dark, sizeof(int)); };
    }
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (profile.AutoConnect && profile.ProtectedPassword.Length > 0) StartConnection();
        else if (profile.ProtectedPassword.Length == 0) ShowConnection(sender, e);
        Dispatcher.BeginInvoke(() => DashboardScroll.ScrollToTop(), DispatcherPriority.ContextIdle);
    }
    private void FillSettings()
    {
        HostInput.Text = profile.Host; PortInput.Text = profile.Port.ToString(); UserInput.Text = profile.Username;
        FingerprintInput.Text = profile.Fingerprint; IntervalInput.Text = profile.IntervalSeconds.ToString();
        PasswordInput.Password = profile.Password;
        AlertsInput.IsChecked = profile.Alerts; AutoConnectInput.IsChecked = profile.AutoConnect;
        ServerAddress.Text = profile.Host;
    }
    private void ShowOverview(object sender, RoutedEventArgs e)
    {
        Admin.Visibility = Visibility.Collapsed; Admin.HideSecrets(); UsersNav.Background = Brushes.Transparent;
        SettingsOverlay.Visibility = Visibility.Collapsed; DashboardScroll.Visibility = Visibility.Visible; PageTitle.Text = "Server overview";
        Footer.Text = "READ-ONLY SSH   ·   ENCRYPTED CONNECTION";
        ConnectionActions.Visibility = Visibility.Visible;
        LastUpdated.Visibility = Visibility.Visible;
        PageSubtitle.Text = "Live health, resource usage and network activity";
        OverviewNav.Background = Palette.Brush("#22372F"); ConnectionNav.Background = Brushes.Transparent;
    }
    private void ShowConnection(object sender, RoutedEventArgs e)
    {
        Admin.Visibility = Visibility.Collapsed; Admin.HideSecrets(); UsersNav.Background = Brushes.Transparent;
        SettingsOverlay.Visibility = Visibility.Visible; DashboardScroll.Visibility = Visibility.Hidden; PageTitle.Text = "Connection settings";
        Footer.Text = "READ-ONLY SSH   ·   ENCRYPTED CONNECTION";
        ConnectionActions.Visibility = Visibility.Visible;
        LastUpdated.Visibility = Visibility.Visible;
        PageSubtitle.Text = "Configure the SSH connection used by Overview";
        OverviewNav.Background = Brushes.Transparent; ConnectionNav.Background = Palette.Brush("#22372F");
    }
    private void ShowUsers(object sender, RoutedEventArgs e)
    {
        SettingsOverlay.Visibility = Visibility.Collapsed; DashboardScroll.Visibility = Visibility.Hidden; Admin.Visibility = Visibility.Visible;
        ConnectionActions.Visibility = Visibility.Collapsed;
        LastUpdated.Visibility = Visibility.Collapsed;
        PageTitle.Text = "People"; Footer.Text = "ADMINISTRATOR HTTPS   ·   ACTIONS REQUIRE CONFIRMATION";
        PageSubtitle.Text = "Select an account to manage rank, feature grants and account actions";
        OverviewNav.Background = Brushes.Transparent; ConnectionNav.Background = Brushes.Transparent; UsersNav.Background = Palette.Brush("#22372F");
    }
    internal void PreviewAdmin() { ShowUsers(this, new RoutedEventArgs()); Admin.ShowPreview(false); }
    internal async Task CaptureAdminPreview(string directory)
    {
        ShowUsers(this, new RoutedEventArgs());
        await Task.Delay(200); Capture(Path.Combine(directory, "admin-sign-in.png"));
        PreviewAdmin();
        await Task.Delay(200); Capture(Path.Combine(directory, "admin-users.png"));
        Width = MinWidth; Height = MinHeight;
        await Task.Delay(200); Capture(Path.Combine(directory, "admin-compact.png"));
        await Admin.ExercisePreview(directory, Capture);
        File.WriteAllText(Path.Combine(directory, "admin-ui-checks.json"), System.Text.Json.JsonSerializer.Serialize(new { status = "rendered", offlineSyntheticData = true, noServerRequests = true, login = true, users = true, minimumSize = true }));
    }
    private async void SaveConnection(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!int.TryParse(PortInput.Text, out int port) || !int.TryParse(IntervalInput.Text, out int interval)) throw new InvalidOperationException("Port and refresh interval must be whole numbers.");
            var updated = new ConnectionProfile { Host = HostInput.Text.Trim(), Port = port, Username = UserInput.Text.Trim(), Fingerprint = FingerprintInput.Text.Trim(), IntervalSeconds = interval, Alerts = AlertsInput.IsChecked == true, AutoConnect = AutoConnectInput.IsChecked == true };
            updated.SetPassword(PasswordInput.Password);
            updated.Validate();
            await StopConnection();
            Profiles.Save(updated); profile = updated; SettingsError.Text = "";
            ServerAddress.Text = profile.Host;
            ShowOverview(sender, e); StartConnection();
        }
        catch (Exception error) { SettingsError.Text = error.Message; }
    }
    private async void ToggleConnection(object sender, RoutedEventArgs e)
    {
        if (cancellation != null) await StopConnection();
        else
        {
            try { profile.Validate(); StartConnection(); }
            catch (Exception error) { SettingsError.Text = error.Message; ShowConnection(sender, e); }
        }
    }
    private void StartConnection()
    {
        if (cancellation != null || closing) return;
        var tokenSource = new CancellationTokenSource(); cancellation = tokenSource;
        ConnectButton.Content = "Disconnect";
        ConnectionStatus.Text = "CONNECTING"; StatusDot.Fill = Palette.Amber;
        HealthHeading.Text = "Connecting to your server"; HealthHeading.Foreground = Palette.Green; HealthDetail.Text = "Verifying the server identity and opening an encrypted connection…";
        var saved = profile;
        polling = Task.Run(() => Poll(saved, tokenSource.Token));
    }
    private async Task StopConnection()
    {
        if (cancellation == null) return;
        ConnectButton.IsEnabled = false;
        var source = cancellation;
        source.Cancel();
        var current = session;
        if (current != null) await Task.Run(() => { try { current.Dispose(); } catch { /* already closed */ } });
        if (polling != null) { try { await polling; } catch (OperationCanceledException) { } }
        source.Dispose(); cancellation = null; polling = null; session = null;
        ClearReadings(); ConnectButton.Content = "Connect"; ConnectButton.IsEnabled = true;
        ConnectionStatus.Text = "DISCONNECTED"; StatusDot.Fill = Palette.Muted;
        HealthHeading.Text = "Monitoring paused"; HealthHeading.Foreground = Palette.Muted; HealthDetail.Text = "Connect again to resume live readings. Session history stays in this window.";
    }
    private async Task Poll(ConnectionProfile saved, CancellationToken token)
    {
        int failures = 0;
        while (!token.IsCancellationRequested)
        {
            using var client = new TelemetryClient(); session = client;
            try
            {
                client.Connect(saved);
                Reading? previous = null;
                while (!token.IsCancellationRequested)
                {
                    var watch = Stopwatch.StartNew();
                    var reading = client.Read();
                    var rates = Rates.Between(previous, reading);
                    var before = previous;
                    double latency = watch.Elapsed.TotalMilliseconds;
                    if (token.IsCancellationRequested) break;
                    await Dispatcher.InvokeAsync(() => { if (!token.IsCancellationRequested) Apply(reading, rates, before, latency); });
                    previous = reading; failures = 0;
                    await Task.Delay(TimeSpan.FromSeconds(saved.IntervalSeconds), token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                if (token.IsCancellationRequested) break;
                failures++;
                bool blocked = client.HostMismatch || error is SshAuthenticationException;
                string message = client.HostMismatch ? "Server identity changed. The connection was blocked. Verify the host-key fingerprint before reconnecting."
                    : error is SshAuthenticationException ? "SSH sign-in was refused. Check the username and password in Connection settings."
                    : error is IOException ? error.Message
                    : "The server could not be reached. Check the connection or server availability.";
                int retry = Math.Min(30, failures * 5);
                await Dispatcher.InvokeAsync(() =>
                {
                    if (token.IsCancellationRequested) return;
                    ClearReadings();
                    history.Add((DateTime.Now, null, null, null, null)); TrimHistory(); RefreshChart();
                    ConnectionStatus.Text = blocked ? "BLOCKED" : "RECONNECTING"; StatusDot.Fill = Palette.Red;
                    HealthHeading.Text = blocked ? "Connection needs attention" : "Connection interrupted";
                    HealthHeading.Foreground = Palette.Amber;
                    HealthDetail.Text = message + (blocked ? "" : $" Retrying in {retry} seconds.");
                });
                if (blocked)
                {
                    // Wait without retrying a bad password or changed server identity.
                    try { await Task.Delay(Timeout.Infinite, token); } catch (OperationCanceledException) { }
                    break;
                }
                try { await Task.Delay(TimeSpan.FromSeconds(retry), token); } catch (OperationCanceledException) { break; }
            }
        }
    }
    private void Apply(Reading r, Rates rates, Reading? previous, double latency)
    {
        lastReading = DateTime.Now; isLive = true; SampleCount++;
        double memory = (r.MemoryTotal - r.MemoryAvailable) * 100.0 / r.MemoryTotal;
        double disk = r.DiskUsed * 100.0 / r.DiskTotal;
        CpuCard.Update(rates.Cpu is {} cpu ? $"{cpu:0.0}%" : "Sampling…", $"{r.Cores} vCPU  ·  {r.Load:0.00} load average", rates.Cpu);
        MemoryCard.Update($"{memory:0.0}%", $"{Format.Bytes(r.MemoryTotal - r.MemoryAvailable)} of {Format.Bytes(r.MemoryTotal)} used", memory);
        DiskCard.Update($"{disk:0.0}%", $"{Format.Bytes(r.DiskAvailable)} available  ·  {Format.Bytes(r.DiskTotal)} total", disk);
        ReceiveValue.Text = Format.Rate(rates.Download); SendValue.Text = Format.Rate(rates.Upload);
        UptimeValue.Text = Format.Uptime(r.Uptime);
        InterfaceName.Text = r.Network?.Interface ?? "Interface unavailable";
        LatencyValue.Text = $"{latency:0} ms sample round trip";
        ServerName.Text = r.Host.ToUpperInvariant(); ServerAddress.Text = profile.Host;
        ConnectionStatus.Text = "LIVE"; StatusDot.Fill = Palette.Green;
        history.Add((DateTime.Now, rates.Cpu, memory, rates.Download, rates.Upload)); TrimHistory(); RefreshChart();
        RenderServices(r, previous);
        var alerts = new List<string>();
        if (rates.Cpu >= 90) alerts.Add("CPU is above 90%");
        if (memory >= 85) alerts.Add("Memory is above 85%");
        if (disk >= 85) alerts.Add("Drive is above 85%");
        string[] expectedServices = ["dorham", "livekit", "caddy", "haproxy"];
        foreach (var name in expectedServices)
        {
            var service = r.Services.FirstOrDefault(s => s.Name == name);
            if (service == null || service.State != "active") alerts.Add(name + " is " + (service?.State ?? "unavailable"));
        }
        if (r.Traffic is { QuotaBytes: > 0 } traffic)
        {
            double used = (traffic.IncomingMeasuredBytes + traffic.AccountingReserveBytes) * 100.0 / traffic.QuotaBytes;
            TrafficBar.Value = Math.Clamp(used, 0, 100); TrafficBar.Foreground = used >= 80 ? Palette.Amber : Palette.Green;
            // The provider sells decimal GB; keep those units distinct from RAM/disk GiB.
            TrafficValue.Text = $"{(traffic.IncomingMeasuredBytes + traffic.AccountingReserveBytes) / 1e9:0.00} / {traffic.QuotaBytes / 1e9:0} GB";
            bool stale = !DateTimeOffset.TryParse(traffic.MeasuredAt, out var measured) || (DateTimeOffset.UtcNow - measured).TotalMinutes > 5;
            TrafficDetail.Text = $"{traffic.EstimatedRemainingBytes / 1e9:0.00} GB remaining · includes setup reserve · " + (stale ? "counter is stale or timestamp unavailable. " : "updated " + measured.ToLocalTime().ToString("HH:mm") + ". ") + "Provider billing is authoritative.";
            if (used >= 80) alerts.Add("Incoming traffic allowance is above 80%");
            if (stale) alerts.Add("Traffic counter needs attention");
        }
        else { TrafficValue.Text = "Unavailable"; TrafficBar.Value = 0; TrafficDetail.Text = "The existing server traffic counter could not be read. Provider billing is authoritative."; }
        bool warning = profile.Alerts && alerts.Count > 0;
        HealthHeading.Text = warning ? "Your server needs a little attention" : alerts.Count > 0 ? "Connected · alerts are turned off" : "Everything is looking good";
        HealthHeading.Foreground = warning ? Palette.Amber : Palette.Green;
        HealthDetail.Text = warning ? string.Join(" · ", alerts) : $"Live readings from {r.Host}. Refreshed every {profile.IntervalSeconds} seconds.";
        UpdateAge();
    }
    private void RenderServices(Reading r, Reading? before)
    {
        ServicesPanel.Children.Clear();
        foreach (string name in new[] { "dorham", "livekit", "caddy", "haproxy" })
        {
            var s = r.Services.FirstOrDefault(s => s.Name == name);
            var row = new Grid { Margin = new(0, 7, 0, 7) };
            row.ColumnDefinitions.Add(new() { Width = new(12) }); row.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) }); row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            var dot = new System.Windows.Shapes.Ellipse { Width = 6, Height = 6, Fill = s?.State == "active" ? Palette.Green : Palette.Amber, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center };
            row.Children.Add(dot);
            var names = new StackPanel();
            names.Children.Add(new TextBlock { Text = name, FontSize = 12 });
            names.Children.Add(new TextBlock { Text = name switch { "dorham" => "Chat & accounts", "livekit" => "Voice & screen sharing", "caddy" => "Web gateway", _ => "Connection routing" }, FontSize = 10, Foreground = Palette.Muted, Margin = new(0, 3, 0, 0) });
            Grid.SetColumn(names, 1); row.Children.Add(names);
            var previous = before?.Services.FirstOrDefault(p => p.Name == name);
            double? cpu = before != null && before.BootId == r.BootId && r.Time > before.Time && s?.CpuNs is {} ns && previous?.CpuNs is {} old && ns >= old ? (ns - old) / 1e9 / (r.Time - before.Time) / r.Cores * 100 : null;
            var status = new TextBlock { Text = s == null ? "unavailable" : s.State == "active" ? (s.Memory is {} bytes ? Format.Bytes(bytes) : "active") : s.State, Foreground = s?.State == "active" ? Palette.Muted : Palette.Amber, FontSize = 11, VerticalAlignment = VerticalAlignment.Center, ToolTip = cpu is {} percent ? $"{s!.State} · {percent:0.0}% of server CPU" : s?.State ?? "Service status unavailable" };
            Grid.SetColumn(status, 2); row.Children.Add(status); ServicesPanel.Children.Add(row);
        }
    }
    private void ClearReadings()
    {
        isLive = false;
        foreach (var card in new[] { CpuCard, MemoryCard, DiskCard }) card.Update("—", "Live reading unavailable", null);
        ReceiveValue.Text = SendValue.Text = UptimeValue.Text = LatencyValue.Text = "—";
        ServicesPanel.Children.Clear(); ServicesPanel.Children.Add(new TextBlock { Text = "Service status unavailable", Foreground = Palette.Muted, Margin = new(0, 10, 0, 0) });
        TrafficValue.Text = "—"; TrafficBar.Value = 0; TrafficDetail.Text = "Live traffic counter unavailable. Provider billing is authoritative.";
        UpdateAge();
    }
    private void TrimHistory()
    {
        while (history.Count > 0 && history[0].Time < DateTime.Now.AddMinutes(-5)) history.RemoveAt(0);
        while (history.Count > 160) history.RemoveAt(0);
    }
    private void UpdateAge()
    {
        LastUpdated.Text = lastReading is {} time ? $"Last reading {time:HH:mm:ss} · {Math.Max(0, (int)(DateTime.Now - time).TotalSeconds)}s ago" + (isLive ? "" : " · unavailable") : "No readings yet";
    }
    private void SelectResources(object sender, RoutedEventArgs e) { networkChart = false; RefreshChart(); }
    private void SelectNetwork(object sender, RoutedEventArgs e) { networkChart = true; RefreshChart(); }
    private void RefreshChart()
    {
        Chart.Percentage = !networkChart; Chart.Second = networkChart ? Palette.Blue : Palette.Purple;
        Chart.Values.Clear();
        foreach (var sample in history) Chart.Values.Add(networkChart ? (sample.Rx, sample.Tx) : (sample.Cpu, sample.Memory));
        LegendA.Text = networkChart ? "Receiving" : "CPU"; LegendB.Text = networkChart ? "Sending" : "Memory"; LegendDotB.Fill = Chart.Second;
        ResourcesTab.Background = networkChart ? Palette.Brush("#232937") : Palette.Brush("#2A3933");
        NetworkTab.Background = networkChart ? Palette.Brush("#2A3933") : Palette.Brush("#232937");
        ChartStart.Text = history.Count > 0 ? history[0].Time.ToString("HH:mm:ss") : "Waiting for samples";
        Chart.InvalidateVisual();
    }
    public void Capture(string path)
    {
        UpdateLayout();
        var visual = (FrameworkElement)Content;
        var dpi = VisualTreeHelper.GetDpi(visual);
        var bitmap = new RenderTargetBitmap((int)(visual.ActualWidth * dpi.DpiScaleX), (int)(visual.ActualHeight * dpi.DpiScaleY), 96 * dpi.DpiScaleX, 96 * dpi.DpiScaleY, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var output = File.Create(path); encoder.Save(output);
    }
    public async Task ExerciseUi(string directory)
    {
        Directory.CreateDirectory(directory);
        async Task WaitForSamples(int minimum)
        {
            for (int i = 0; i < 80 && SampleCount < minimum; i++) await Task.Delay(500);
            if (SampleCount < minimum || !isLive) throw new InvalidOperationException("Live dashboard did not receive enough readings.");
        }
        void Assert(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); }
        await WaitForSamples(3);
        Assert(CpuCard.CurrentText.EndsWith('%') && MemoryCard.CurrentText.EndsWith('%') && DiskCard.CurrentText.EndsWith('%'), "Resource cards did not show live percentages.");
        SelectNetwork(this, new RoutedEventArgs());
        Assert(!Chart.Percentage && LegendA.Text == "Receiving" && Chart.Values.Any(v => v.A != null), "Network tab did not switch to live byte-rate history.");
        Capture(Path.Combine(directory, "network.png"));
        ShowConnection(this, new RoutedEventArgs());
        Assert(SettingsOverlay.Visibility == Visibility.Visible && HostInput.Text == profile.Host && FingerprintInput.Text == profile.Fingerprint, "Connection form did not load the profile.");
        Capture(Path.Combine(directory, "connection.png"));
        ShowOverview(this, new RoutedEventArgs());
        int interruptionCount = SampleCount;
        var interruptedSession = session;
        await Task.Run(() => interruptedSession?.Dispose());
        for (int i = 0; i < 40 && ConnectionStatus.Text != "RECONNECTING"; i++) await Task.Delay(100);
        Assert(ConnectionStatus.Text == "RECONNECTING" && CpuCard.CurrentText == "—", "Interrupted connection was not visibly marked unavailable.");
        Capture(Path.Combine(directory, "reconnecting.png"));
        await WaitForSamples(interruptionCount + 3);
        await StopConnection();
        Assert(!isLive && CpuCard.CurrentText == "—" && MemoryCard.CurrentText == "—" && DiskCard.CurrentText == "—" && ReceiveValue.Text == "—" && ConnectionStatus.Text == "DISCONNECTED", "Disconnect retained readings that could look live.");
        Capture(Path.Combine(directory, "paused.png"));
        int previousCount = SampleCount;
        StartConnection();
        await WaitForSamples(previousCount + 3);
        SelectResources(this, new RoutedEventArgs());
        Assert(Chart.Percentage && ConnectionStatus.Text == "LIVE", "Reconnect did not restore resource readings.");
        DashboardScroll.ScrollToTop();
        await Task.Delay(250);
        Capture(Path.Combine(directory, "dashboard.png"));
        double oldWidth = Width, oldHeight = Height;
        Width = MinWidth; Height = MinHeight;
        await Task.Delay(400);
        Capture(Path.Combine(directory, "compact.png"));
        Width = oldWidth; Height = oldHeight;
        var process = Process.GetCurrentProcess();
        File.WriteAllText(Path.Combine(directory, "ui-checks.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            status = "passed", liveResourceCards = true, networkTab = true, connectionForm = true,
            interruptedSshClearsReadings = true, automaticReconnect = true,
            disconnectClearsReadings = true, reconnectRestoresReadings = true, minimumWindowRendered = true,
            liveSamples = SampleCount, processWorkingSetBytes = process.WorkingSet64,
            capturedAt = DateTimeOffset.UtcNow
        }, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        Admin.CloseSession();
        closing = true; clock.Stop(); cancellation?.Cancel();
        var current = session;
        _ = Task.Run(() => { try { current?.Dispose(); } catch { } });
    }
}
