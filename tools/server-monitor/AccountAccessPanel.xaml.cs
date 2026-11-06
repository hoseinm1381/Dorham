using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;

namespace Dorham.Monitor;

public partial class AccountAccessPanel : UserControl
{
    private sealed record Option(string Id, string Label);
    private sealed record Choices(Option[] Features, Option[] Badges);
    private static readonly string[] Ranks = ["None", "Plus", "Pro", "Ultra", "Max"];
    private AdminClient? client;
    private ManagedUser? account;
    private Task<Choices>? choicesRequest;
    private int selection;
    private string rank = "None";
    internal Task Loading { get; private set; } = Task.CompletedTask;
    internal event Action? SessionExpired;

    public AccountAccessPanel()
    {
        InitializeComponent();
        RankPicker.ItemsSource = Ranks;
    }

    internal void SelectAccount(AdminClient? session, ManagedUser? user, bool reload = false)
    {
        if (!reload && ReferenceEquals(client, session) && account?.Id == user?.Id) return;
        if (reload || !ReferenceEquals(client, session)) choicesRequest = null;
        client = session;
        account = user;
        int generation = ++selection;
        Visibility = user == null ? Visibility.Collapsed : Visibility.Visible;
        Editor.Visibility = Visibility.Collapsed;
        RetryButton.Visibility = Visibility.Collapsed;
        Expiry.Clear();
        Loading = Task.CompletedTask;
        if (user == null) return;
        if (session?.FeatureManagement != true)
        {
            AccessStatus.Text = "This server does not offer feature grants.";
            return;
        }
        AccessStatus.Text = "Loading access…";
        Loading = Read(session, user, generation);
    }

    private async Task<Choices> ReadChoices(AdminClient session)
    {
        using var result = await session.FeatureRequest(HttpMethod.Get, "features");
        var features = result.RootElement.GetProperty("features").EnumerateArray()
            .Select(row => row.GetString()!).Where(key => key != "communityPlus")
            .Select(key => new Option(key, FeatureLabel(key))).ToArray();
        var badges = result.RootElement.GetProperty("catalog").EnumerateArray()
            .Where(row => row.GetProperty("access").GetString() == "awarded" && row.GetProperty("active").GetInt64() == 1)
            .Select(row => new Option(row.GetProperty("id").GetString()!, row.GetProperty("label").GetString()!))
            .Prepend(new Option("", "Remove awarded badge")).ToArray();
        return new Choices(features, badges);
    }

    private async Task Read(AdminClient session, ManagedUser user, int generation)
    {
        try
        {
            var options = await (choicesRequest ??= ReadChoices(session));
            if (selection != generation) return;
            using var access = await session.FeatureRequest(HttpMethod.Get, "features/users/" + user.Id);
            if (selection != generation) return;
            Render(access.RootElement, options);
            AccessStatus.Text = "Grants are per account. Server policies also apply.";
            Editor.Visibility = Visibility.Visible;
            Editor.IsEnabled = true;
        }
        catch (Exception error)
        {
            if (selection == generation) ShowError(error);
        }
    }

    private void Render(JsonElement access, Choices options)
    {
        rank = Ranks.FirstOrDefault(value => value.Equals(access.GetProperty("rank").GetString(), StringComparison.OrdinalIgnoreCase)) ?? "None";
        RankPicker.SelectedItem = rank;
        SaveRankButton.IsEnabled = false;
        AwardPicker.ItemsSource = options.Badges;
        AwardPicker.SelectedIndex = -1;
        FeatureRows.Children.Clear();
        var grants = access.GetProperty("grants");
        bool canSelectSpeech = access.TryGetProperty("plusSelected", out var speechChoice);
        foreach (var option in options.Features)
        {
            bool granted = grants.TryGetProperty(option.Id, out var end);
            bool manageVoice = option.Id == "ttsPlus" && canSelectSpeech;
            bool plusSelected = manageVoice && speechChoice.ValueKind == JsonValueKind.True;
            var expiry = granted ? end.GetInt64() : 0;
            var state = !granted ? "No access" : expiry == 0 ? "Granted · no expiry" : "Granted until " + DateTimeOffset.FromUnixTimeMilliseconds(expiry).ToLocalTime().ToString("g");
            if (granted && manageVoice) state += plusSelected ? " · AI voice selected" : " · Standard voice selected";
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 5) };
            var button = new Button { Content = granted ? "Remove" : "Grant", MinWidth = 72, Padding = new Thickness(9, 5, 9, 5), Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            AutomationProperties.SetName(button, (granted ? "Remove " : "Grant ") + option.Label);
            button.Click += async (_, _) => await ChangeGrant(option, !granted, manageVoice && !granted);
            DockPanel.SetDock(button, Dock.Right);
            row.Children.Add(button);
            if (granted && manageVoice && !plusSelected)
            {
                var enable = new Button { Content = "Enable AI voice", Padding = button.Padding, Margin = button.Margin, VerticalAlignment = VerticalAlignment.Center };
                enable.Click += async (_, _) => await EnableExistingTtsPlus();
                DockPanel.SetDock(enable, Dock.Right);
                row.Children.Add(enable);
            }
            var label = new StackPanel();
            label.Children.Add(new TextBlock { Text = option.Label, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
            label.Children.Add(new TextBlock { Text = state, Foreground = (Brush)FindResource(granted ? "Accent" : "Muted"), FontSize = 11, TextWrapping = TextWrapping.Wrap });
            if (option.Id == "ttsPlus" && access.TryGetProperty("ttsPlusUsage", out var usage))
                label.Children.Add(new TextBlock { Text = SpeechUsageText(usage), Foreground = (Brush)FindResource("Muted"), FontSize = 11, TextWrapping = TextWrapping.Wrap });
            row.Children.Add(label);
            FeatureRows.Children.Add(new Border { Child = row, BorderBrush = (Brush)FindResource("Border"), BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(0, 6, 0, 5) });
        }
    }

    private static string SpeechUsageText(JsonElement usage)
    {
        long Count(string field) => usage.GetProperty(field).GetInt64();
        var month = usage.GetProperty("month").GetString();
        var characters = Count("characters");
        var attempts = Count("attempts");
        var reported = Count("reported");
        var priced = Count("priced");
        var quota = $"{month} UTC · {characters:N0} quota characters";
        if (reported == 0)
            return quota + (attempts == 0 ? " · No token reports yet" : $" · No token reports for {attempts:N0} attempts");
        var text = $"{quota}\n{Count("inputTokens"):N0} input + {Count("outputTokens"):N0} output tokens";
        if (priced > 0)
        {
            decimal dollars = Count("estimatedNanoUsd") / 1_000_000_000m;
            text += dollars == 0 ? " · Est. $0.0000" : dollars < 0.0001m ? " · Est. <$0.0001" : $" · Est. ${dollars:F4}";
        }
        else text += " · Cost unavailable";
        if (reported < attempts) text += $"\nTokens reported for {reported:N0} of {attempts:N0} attempts";
        if (priced > 0 && priced < attempts) text += $"\nCost estimate covers {priced:N0} of {attempts:N0} attempts";
        return text;
    }

    private void RankChanged(object sender, SelectionChangedEventArgs e) =>
        SaveRankButton.IsEnabled = RankPicker.SelectedItem is string value && value != rank;
    private void AwardChanged(object sender, SelectionChangedEventArgs e) =>
        SaveAwardButton.IsEnabled = AwardPicker.SelectedItem is Option;
    private async void SaveRank(object sender, RoutedEventArgs e)
    {
        if (RankPicker.SelectedItem is string value && account is { } user && Confirm($"Set @{user.Username}'s rank badge to {value}?"))
            await Apply("features/users/" + user.Id, new { rank = value.ToLowerInvariant() });
    }
    private async void SaveAward(object sender, RoutedEventArgs e)
    {
        if (AwardPicker.SelectedItem is Option badge && account is { } user && Confirm($"Apply “{badge.Label}” for @{user.Username}?"))
            await Apply("features/badge/" + user.Id, new { id = badge.Id });
    }
    private async Task ChangeGrant(Option feature, bool enabled, bool selectTtsPlus)
    {
        if (account is not { } user) return;
        long expiresAt = 0;
        if (enabled && !string.IsNullOrWhiteSpace(Expiry.Text))
        {
            if (!DateTimeOffset.TryParse(Expiry.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out var date) || date <= DateTimeOffset.Now)
            {
                AccessStatus.Text = "Enter a future date and time or clear the optional expiry.";
                return;
            }
            expiresAt = date.ToUnixTimeMilliseconds();
        }
        var confirmation = !enabled ? $"Remove {feature.Label} from @{user.Username}?" :
            selectTtsPlus ? $"Grant TTS Plus and select the AI voice for @{user.Username}?" : $"Grant {feature.Label} to @{user.Username}?";
        if (Confirm(confirmation))
        {
            var payload = new Dictionary<string, object> { ["feature"] = feature.Id, ["enabled"] = enabled, ["expiresAt"] = expiresAt };
            if (selectTtsPlus) payload["selectTtsPlus"] = true;
            await Apply("features/users/" + user.Id, payload);
        }
    }
    private async Task EnableExistingTtsPlus()
    {
        if (account is { } user && Confirm($"Select the TTS Plus AI voice for @{user.Username}?"))
            await Apply("features/users/" + user.Id, new { selectTtsPlus = true });
    }
    private bool Confirm(string text) =>
        MessageBox.Show(Window.GetWindow(this), text, "Confirm account change", MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK;
    private async Task Apply(string path, object payload)
    {
        if (client is not { } session || account is not { } user || !Editor.IsEnabled) return;
        int generation = selection;
        Editor.IsEnabled = false;
        AccessStatus.Text = "Saving…";
        try
        {
            using var response = await session.FeatureRequest(HttpMethod.Put, path, payload);
            if (selection != generation) return;
            Expiry.Clear();
            await Read(session, user, generation);
        }
        catch (Exception error)
        {
            if (selection == generation) ShowError(error);
        }
    }

    private void ShowError(Exception error)
    {
        Editor.IsEnabled = false;
        RetryButton.Visibility = Visibility.Visible;
        AccessStatus.Text = error is AdminApiException or InvalidOperationException ? error.Message :
            "Could not confirm the current access. Reload it before retrying.";
        if (client?.SignedIn != true) SessionExpired?.Invoke();
    }
    private void Retry(object sender, RoutedEventArgs e) => SelectAccount(client, account, reload: true);
    internal static string FeatureLabel(string key) => key switch
    {
        "screen1080" => "1080p screen sharing",
        "ttsPlus" => "TTS Plus",
        "profilePlus" => "Profile Plus",
        "emojiPlus" => "Emoji Plus",
        "soundboardPlus" => "Soundboard Plus",
        "uploadsPlus" => "Uploads Plus",
        "communityPlus" => "Community Plus",
        "soundboard" => "Soundboard",
        _ => key
    };
}
