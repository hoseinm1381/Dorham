using System.Globalization;
using System.IO;
using System.Media;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace Dorham.Monitor;

internal sealed class FeatureAdminWindow : Window
{
    private readonly AdminClient client;
    private readonly ListBox sections = new() { Background = Brushes.Transparent, BorderThickness = new Thickness(0), Foreground = Brushes.White };
    private readonly ScrollViewer workspace = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly (string Name, Func<StackPanel> Content)[] pages;
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(12) };
    private JsonElement config;
    private SoundPlayer? previewPlayer;
    private bool busy;
    private bool closed;

    public FeatureAdminWindow(AdminClient client)
    {
        this.client = client;
        Title = "Dorham Monitor · Server tools";
        Width = 930; Height = 730; MinWidth = 650; MinHeight = 480;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        pages = [("Feature policies", Policies), ("Communities", Communities), ("Asset library", Catalog),
            ("Speech provider", Speech), ("Announcements", Announcements), ("Audit history", Audit), ("Backend metrics", Dashboard)];

        var root = new DockPanel { Margin = new Thickness(20) };
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 16) };
        var refresh = new Button { Content = "Reload settings", VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
        refresh.Click += async (_, _) => await LoadForDisplay();
        DockPanel.SetDock(refresh, Dock.Right);
        header.Children.Add(refresh);
        var heading = new StackPanel();
        heading.Children.Add(new TextBlock { Text = "Server tools", FontSize = 25, FontWeight = FontWeights.SemiBold });
        heading.Children.Add(new TextBlock { Text = "Server-wide settings, content, and activity", Foreground = (Brush)FindResource("Muted"), Margin = new Thickness(0, 4, 0, 0) });
        header.Children.Add(heading);
        DockPanel.SetDock(header, Dock.Top);
        root.Children.Add(header);
        DockPanel.SetDock(status, Dock.Bottom);
        root.Children.Add(status);

        sections.ItemContainerStyle = (Style)FindResource("ToolNavigationItem");
        foreach (var page in pages) sections.Items.Add(page.Name);
        sections.SelectionChanged += (_, _) => { if (!busy && config.ValueKind == JsonValueKind.Object) ShowPage(); };
        sections.SelectedIndex = 0;
        var navigation = new Border { Width = 175, Background = (Brush)FindResource("Surface"), CornerRadius = new CornerRadius(10), Padding = new Thickness(7), Margin = new Thickness(0, 0, 12, 0), Child = sections };
        DockPanel.SetDock(navigation, Dock.Left);
        root.Children.Add(navigation);
        var content = new Border { Background = (Brush)FindResource("Surface"), CornerRadius = new CornerRadius(10), Child = workspace };
        root.Children.Add(content);
        Content = root;
        Loaded += async (_, _) => await LoadForDisplay();
        Closed += (_, _) => { closed = true; previewPlayer?.Dispose(); };
    }

    internal Task LoadForDisplay() => Run(ReloadUi);

    internal async Task VerifyNavigation()
    {
        await LoadForDisplay();
        for (int index = 0; index < pages.Length; index++)
        {
            sections.SelectedIndex = index;
            if (workspace.Content is not StackPanel panel || panel.Children[0] is not TextBlock heading || heading.Text != pages[index].Name)
                throw new InvalidOperationException("Server tools did not open " + pages[index].Name + ".");
        }
    }

    private static JsonElement Get(JsonElement item, string key) =>
        item.ValueKind == JsonValueKind.Object && item.TryGetProperty(key, out var value) ? value : default;
    private static string Str(JsonElement item, string key, string fallback = "") =>
        Get(item, key) is { ValueKind: JsonValueKind.String } value ? value.GetString() ?? fallback : fallback;
    private static long Num(JsonElement item, string key, long fallback = 0) =>
        Get(item, key) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt64(out var number) ? number : fallback;
    private static bool Flag(JsonElement item, string key, bool fallback = false) =>
        Get(item, key) is { ValueKind: JsonValueKind.True or JsonValueKind.False } value ? value.GetBoolean() : fallback;
    private static IEnumerable<JsonElement> Rows(JsonElement item, string key) =>
        Get(item, key) is { ValueKind: JsonValueKind.Array } value ? value.EnumerateArray() : [];

    private async Task Run(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        sections.IsEnabled = workspace.IsEnabled = false;
        status.Text = "Working…";
        try { await action(); if (!closed) status.Text = "Ready"; }
        catch (Exception e) when (e is AdminApiException or InvalidOperationException or FormatException or IOException or HttpRequestException or TaskCanceledException)
        { if (!closed) status.Text = e is HttpRequestException or TaskCanceledException ? "The request timed out or disconnected. Refresh before retrying." : e.Message; }
        finally { busy = false; if (!closed) sections.IsEnabled = workspace.IsEnabled = true; }
    }

    private async Task Reload()
    {
        using var data = await client.FeatureRequest(HttpMethod.Get, "features");
        config = data.RootElement.Clone();
    }

    private void ShowPage()
    {
        if (closed || sections.SelectedIndex < 0) return;
        var page = pages[sections.SelectedIndex];
        var panel = page.Content();
        panel.Children.Insert(0, new TextBlock { Text = page.Name, FontSize = 19, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 6) });
        workspace.Content = panel;
        workspace.ScrollToTop();
    }

    private static StackPanel Panel(string description)
    {
        var panel = new StackPanel { Margin = new Thickness(16) };
        TextElement.SetForeground(panel, new SolidColorBrush(Color.FromRgb(242, 244, 250)));
        panel.Children.Add(new TextBlock { Text = description, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) });
        return panel;
    }
    private static TextBox Field(Panel panel, string label, string value = "")
    {
        panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 7, 0, 2) });
        var field = new TextBox { Text = value, MinWidth = 220 };
        System.Windows.Automation.AutomationProperties.SetName(field, label);
        panel.Children.Add(field);
        return field;
    }
    private static ComboBox Choice(Panel panel, string label, object items, string? initial = null)
    {
        panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 7, 0, 2) });
        var box = new ComboBox { ItemsSource = (System.Collections.IEnumerable)items, MinWidth = 220, Margin = new Thickness(0, 0, 0, 4) };
        System.Windows.Automation.AutomationProperties.SetName(box, label);
        box.SelectedIndex = 0;
        if (initial != null) box.SelectedItem = initial;
        panel.Children.Add(box);
        return box;
    }
    private static Button Action(Panel panel, string label, RoutedEventHandler click)
    {
        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 3) };
        button.Click += click; panel.Children.Add(button);
        return button;
    }
    private static bool Confirm(Window owner, string description) =>
        MessageBox.Show(owner, description, "Confirm Dorham change", MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK;
    private static long Number(TextBox box) => long.Parse(box.Text.Trim(), CultureInfo.InvariantCulture);
    private static long Date(TextBox box, bool optional = false)
    {
        if (optional && string.IsNullOrWhiteSpace(box.Text)) return 0;
        if (!DateTimeOffset.TryParse(box.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out var parsed))
            throw new FormatException("Enter a valid local date and time or ISO timestamp.");
        return parsed.ToUnixTimeMilliseconds();
    }
    private static string LocalTime(long time) => time == 0 ? "" : DateTimeOffset.FromUnixTimeMilliseconds(time).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture);
    private static string Pick(ComboBox combo) => combo.SelectedItem as string ?? throw new InvalidOperationException("Select a value first.");
    private async Task Put(string path, object value) { using var result = await client.FeatureRequest(HttpMethod.Put, "features/" + path, value); }
    private async Task ReloadUi() { await Reload(); ShowPage(); }

    private StackPanel Communities()
    {
        var panel = Panel("Grant Community Plus to make community catalog items available to its members.");
        var communities = Rows(config, "communities").Select(row => new Item(Str(row, "id"),
            Str(row, "name") + (Get(row, "expires_at").ValueKind == JsonValueKind.Number ? " · active " + LocalTime(Num(row, "expires_at")) : ""))).ToArray();
        var community = Choice(panel, "Community", communities);
        community.DisplayMemberPath = nameof(Item.Label);
        var expires = Field(panel, "Expiry (local date and time, optional)");
        string Id() => (community.SelectedItem as Item)?.Id ?? throw new InvalidOperationException("Select a community.");
        Action(panel, "Grant Community Plus", async (_, _) => await Run(async () => { await Put("communities/" + Id(), new { enabled = true, expiresAt = Date(expires, true) }); await ReloadUi(); }));
        Action(panel, "Revoke Community Plus", async (_, _) =>
        {
            if (Confirm(this, "Revoke Community Plus for this community?")) await Run(async () => { await Put("communities/" + Id(), new { enabled = false }); await ReloadUi(); });
        });
        var banners = Rows(config, "catalog").Where(item => Str(item, "kind") == "banner" && Num(item, "active") == 1)
            .Select(item => new Item(Str(item, "id"), Str(item, "label"))).Prepend(new Item("", "No banner")).ToArray();
        var banner = Choice(panel, "Community banner", banners);
        banner.DisplayMemberPath = nameof(Item.Label);
        var blurb = Field(panel, "Invite page description");
        var slots = Field(panel, "Community emoji and sticker slots (8–64)", "16");
        void FillBranding()
        {
            if (community.SelectedItem is not Item picked) return;
            var row = Rows(config, "communities").FirstOrDefault(value => Str(value, "id") == picked.Id);
            blurb.Text = Str(row, "invite_blurb");
            slots.Text = Num(row, "community_emoji_slots", 8).ToString(CultureInfo.InvariantCulture);
            var current = Str(row, "community_banner");
            banner.SelectedItem = banners.FirstOrDefault(item => item.Id.Length > 0 && current.StartsWith("/catalog/" + item.Id + "/", StringComparison.Ordinal)) ?? banners[0];
        }
        community.SelectionChanged += (_, _) => FillBranding();
        FillBranding();
        Action(panel, "Save community branding", async (_, _) =>
        {
            if (Confirm(this, "Apply this banner, invite description and emoji limit?"))
                await Run(() => Put("communityBranding/" + Id(), new { bannerId = (banner.SelectedItem as Item)?.Id ?? "", blurb = blurb.Text, emojiSlots = Number(slots) }));
        });
        return panel;
    }

    private StackPanel Policies()
    {
        var panel = Panel("Control which features are available across Dorham. Manage individual grants from People.");
        var settings = Get(config, "settings");
        var switches = new Dictionary<string, CheckBox>();
        foreach (var name in Rows(config, "features").Select(item => item.GetString()!).Append("soundboard"))
        {
            var check = new CheckBox { Content = AccountAccessPanel.FeatureLabel(name), IsChecked = Flag(settings, name, true), Margin = new Thickness(0, 3, 0, 3) };
            switches.Add(name, check); panel.Children.Add(check);
        }
        Action(panel, "Apply global switches", async (_, _) =>
        {
            if (Confirm(this, "Apply these switches to all accounts?")) await Run(() => Put("settings/features", switches.ToDictionary(item => item.Key, item => item.Value.IsChecked == true)));
        });
        var screen = Get(config, "screen");
        var visibility = Choice(panel, "1080p visibility", new[] { "hidden", "selected", "locked" }, Str(screen, "visibility", "hidden"));
        var bitrate = Field(panel, "1080p ceiling (bits per second)", Num(screen, "bitrate", 1500000).ToString(CultureInfo.InvariantCulture));
        Action(panel, "Apply screen policy", async (_, _) =>
        {
            if (Confirm(this, "Apply this 1080p visibility and bitrate policy?")) await Run(() => Put("settings/screen", new { visibility = Pick(visibility), bitrate = Number(bitrate) }));
        });
        var uploadSettings = Get(config, "uploads");
        var enableUploads = new CheckBox { Content = "Enable higher daily upload allowance", IsChecked = Flag(uploadSettings, "enabled"), Margin = new Thickness(0, 12, 0, 0) };
        panel.Children.Add(enableUploads);
        var dailyMiB = Field(panel, "Uploads Plus daily allowance in MiB", Num(uploadSettings, "dailyMiB", 450).ToString(CultureInfo.InvariantCulture));
        Action(panel, "Apply upload policy", async (_, _) =>
        {
            if (Confirm(this, "Apply the new per-account upload allowance? The shared traffic and disk caps still apply.")) await Run(() => Put("settings/uploads", new { enabled = enableUploads.IsChecked == true, dailyMiB = Number(dailyMiB) }));
        });
        return panel;
    }

    private StackPanel Catalog()
    {
        var panel = Panel("Stage image and sound files, preview them, and publish or retire them. Free sounds use slots 1–8.");
        var items = Rows(config, "catalog").Select(row => new Item(Str(row, "id"), Str(row, "kind") + " · " + Str(row, "label") + " · " + (Num(row, "active") == 1 ? "published" : "draft or retired"))).ToArray();
        var list = Choice(panel, "Catalog item", items);
        list.DisplayMemberPath = nameof(Item.Label);
        string Id() => (list.SelectedItem as Item)?.Id ?? throw new InvalidOperationException("Select a catalog item.");
        var image = new Image { Height = 85, HorizontalAlignment = HorizontalAlignment.Left, Visibility = Visibility.Collapsed };
        Action(panel, "Preview selected item", async (_, _) => await Run(async () =>
        {
            using var result = await client.FeatureRequest(HttpMethod.Get, "features/catalog/" + Id());
            var data = Convert.FromBase64String(Str(result.RootElement, "data"));
            image.Visibility = Visibility.Collapsed;
            if (Str(result.RootElement, "mime") == "audio/wav") Play(data);
            else
            {
                using var stream = new MemoryStream(data);
                var bitmap = new BitmapImage();
                bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = stream; bitmap.EndInit();
                image.Source = bitmap; image.Visibility = Visibility.Visible;
            }
        }));
        panel.Children.Add(image);
        Action(panel, "Publish selected item", async (_, _) =>
        {
            if (Confirm(this, "Publish this item for eligible Dorham users?")) await Run(async () => { await Put("catalog/" + Id(), new { active = true }); await ReloadUi(); });
        });
        Action(panel, "Retire selected item", async (_, _) =>
        {
            if (Confirm(this, "Remove this item from active pickers?")) await Run(async () => { await Put("catalog/" + Id(), new { active = false }); await ReloadUi(); });
        });
        Action(panel, "Discard unpublished draft", async (_, _) =>
        {
            if (Confirm(this, "Discard this unpublished draft?")) await Run(async () =>
            {
                using var result = await client.FeatureRequest(HttpMethod.Delete, "features/catalog/" + Id());
                await ReloadUi();
            });
        });
        var kind = Choice(panel, "New item type", new[] { "avatar", "badge", "frame", "banner", "emoji", "sticker", "sound" });
        var access = Choice(panel, "Access", new[] { "free", "profilePlus", "emojiPlus", "soundboardPlus", "communityPlus", "awarded" });
        var community = Choice(panel, "Catalog scope", Rows(config, "communities").Select(item => new Item(Str(item, "id"), Str(item, "name"))).Prepend(new Item("", "Global")).ToArray());
        community.DisplayMemberPath = nameof(Item.Label);
        var label = Field(panel, "Item label");
        var pack = Field(panel, "Pack label (optional)");
        var slot = Field(panel, "Free sound slot (1–8)");
        var file = Field(panel, "File");
        Action(panel, "Browse…", (_, _) =>
        {
            var dialog = new OpenFileDialog { Filter = "Catalog files|*.png;*.jpg;*.jpeg;*.wav", CheckFileExists = true };
            if (dialog.ShowDialog(this) == true) file.Text = dialog.FileName;
        });
        Action(panel, "Upload draft", async (_, _) => await Run(async () =>
        {
            using var result = await client.UploadCatalog(file.Text, label.Text, Pick(kind), Pick(access), (community.SelectedItem as Item)?.Id, slot.Text, pack.Text);
            await ReloadUi();
        }));
        return panel;
    }

    private StackPanel Speech()
    {
        var panel = Panel("TTS Plus uses a server-approved speech endpoint. Credentials stay on the VPS. Preview a Persian or mixed-language sample before enabling.");
        var speech = Get(config, "speech");
        var enabled = new CheckBox { Content = "Enable TTS Plus", IsChecked = Flag(speech, "enabled") };
        panel.Children.Add(enabled);
        var endpoint = Field(panel, "Server-approved endpoint URL", Str(speech, "endpoint"));
        var model = Field(panel, "Model", Str(speech, "model"));
        var voice = Field(panel, "Provider voice ID", Str(speech, "voice"));
        var label = Field(panel, "Name shown in Dorham", Str(speech, "label", "TTS Plus"));
        var timeout = Field(panel, "Timeout (seconds)", Num(speech, "timeoutSeconds", 10).ToString(CultureInfo.InvariantCulture));
        var monthly = Field(panel, "Characters per user per month", Num(speech, "monthlyCharacters", 10000).ToString(CultureInfo.InvariantCulture));
        var global = Field(panel, "Characters across all users per month", Num(speech, "globalMonthlyCharacters", 100000).ToString(CultureInfo.InvariantCulture));
        var sample = Field(panel, "Preview text", "سلام! این یک نمونه برای Dorham است.");
        object Settings() => new { enabled = enabled.IsChecked == true, endpoint = endpoint.Text, model = model.Text, voice = voice.Text, label = label.Text, timeoutSeconds = Number(timeout), monthlyCharacters = Number(monthly), globalMonthlyCharacters = Number(global) };
        Action(panel, "Play preview", async (_, _) => await Run(async () =>
        {
            if (string.IsNullOrWhiteSpace(endpoint.Text) || string.IsNullOrWhiteSpace(model.Text) || string.IsNullOrWhiteSpace(voice.Text))
                throw new InvalidOperationException("Enter a server-approved endpoint URL, model and voice before playing a preview.");
            using var result = await client.FeatureRequest(HttpMethod.Post, "features/speech/preview", new { settings = Settings(), text = sample.Text });
            Play(Convert.FromBase64String(Str(result.RootElement, "wav")));
        }));
        Action(panel, "Apply speech settings", async (_, _) =>
        {
            if (Confirm(this, "Apply this speech configuration?")) await Run(() => Put("settings/speech", Settings()));
        });
        Action(panel, "Restore previous speech settings", async (_, _) =>
        {
            if (Confirm(this, "Restore the previous speech configuration?")) await Run(async () => { await Put("settings/restoreSpeech", new { }); await ReloadUi(); });
        });
        return panel;
    }

    private void Play(byte[] bytes)
    {
        previewPlayer?.Dispose();
        previewPlayer = new SoundPlayer(new MemoryStream(bytes));
        previewPlayer.Load();
        previewPlayer.Play();
    }

    private StackPanel Announcements()
    {
        var panel = Panel("Schedule notices in local time. An empty version targets all compatible versions.");
        var notices = Rows(config, "announcements").Select(row => new Item(Str(row, "id"), LocalTime(Num(row, "starts_at")) + " · " + Str(row, "text_en", Str(row, "text_fa")))).ToArray();
        var existing = Choice(panel, "Published notices", notices);
        existing.DisplayMemberPath = nameof(Item.Label);
        Action(panel, "Remove selected notice", async (_, _) =>
        {
            if (existing.SelectedItem is not Item item || !Confirm(this, "Remove this notice?")) return;
            await Run(async () => { using var result = await client.FeatureRequest(HttpMethod.Delete, "features/announcements/" + item.Id); await ReloadUi(); });
        });
        var en = Field(panel, "English text");
        var fa = Field(panel, "Persian text");
        var platform = Choice(panel, "Platform", new[] { "all", "web", "windows", "android" });
        var version = Field(panel, "Exact version");
        var startsAt = Field(panel, "Start", LocalTime(DateTimeOffset.Now.ToUnixTimeMilliseconds()));
        var endsAt = Field(panel, "End", LocalTime(DateTimeOffset.Now.AddDays(1).ToUnixTimeMilliseconds()));
        Action(panel, "Publish notice", async (_, _) =>
        {
            if (!Confirm(this, "Publish this notice for the selected audience?")) return;
            await Run(async () =>
            {
                using var result = await client.FeatureRequest(HttpMethod.Post, "features/announcements", new { en = en.Text, fa = fa.Text, platform = Pick(platform), version = version.Text, startsAt = Date(startsAt), endsAt = Date(endsAt) });
                await ReloadUi();
            });
        });
        return panel;
    }

    private StackPanel Audit()
    {
        var panel = Panel("Latest audited administrator and moderation actions.");
        var list = new ListBox { Height = 390 };
        Action(panel, "Load audit log", async (_, _) => await Run(async () =>
        {
            using var result = await client.FeatureRequest(HttpMethod.Get, "audit");
            list.ItemsSource = Rows(result.RootElement, "events").Select(row =>
                LocalTime(Num(row, "created_at")) + " · " + Str(row, "action") + " · " + Str(row, "actor_id") + " → " + Str(row, "target_id")).ToArray();
        }));
        panel.Children.Add(list);
        return panel;
    }

    private StackPanel Dashboard()
    {
        var panel = Panel("Live backend counters. The main Monitor dashboard shows host CPU, memory, disk, service status, and network usage.");
        var text = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, MinHeight = 360 };
        Action(panel, "Refresh backend metrics", async (_, _) => await Run(async () =>
        {
            using var result = await client.FeatureRequest(HttpMethod.Get, "metrics");
            var root = result.RootElement;
            var summary = new Dictionary<string, object>();
            foreach (var key in new[] { "version", "connectedUsers", "shares", "hdShares", "tts", "memory", "sfuControl", "storage" })
                if (root.TryGetProperty(key, out var value)) summary[key] = value;
            text.Text = JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true });
        }));
        panel.Children.Add(text);
        return panel;
    }

    private sealed record Item(string Id, string Label);
}
