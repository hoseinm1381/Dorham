using System.Net.Http;
using System.IO;
using System.Windows;
using System.Windows.Controls;

namespace Dorham.Monitor;

public partial class AdminPanel : UserControl
{
    private AdminClient? client;
    private List<ManagedUser> users = [];
    private ManagedUser? selected;
    private string? pendingAction;
    private ManagedUser? pendingUser;
    private bool busy;
    private string? temporaryPassword;

    public AdminPanel()
    {
        InitializeComponent();
        AccessEditor.SessionExpired += () => { ShowSession(); Notice.Text = "Your administrator session expired. Sign in to continue."; };
        UpdateButtons();
    }

    private async void SignIn(object sender, RoutedEventArgs e)
    {
        await Run(async () =>
        {
            client?.Dispose(); client = new AdminClient(Endpoint.Text);
            var password = LoginPassword.Password; LoginPassword.Clear();
            users = await client.SignIn(Username.Text, password);
            ShowSession(); ApplyFilter();
            Notice.Text = "";
        });
    }

    private void ShowSession()
    {
        bool signedIn = client?.SignedIn == true;
        LoginView.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        UsersView.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        if (signedIn)
        {
            SessionLabel.Text = "Signed in as " + client!.AdministratorName;
            var unavailable = new List<string>();
            if (!client.Supports("setPassword")) unavailable.Add("chosen passwords");
            if (!client.Supports("delete")) unavailable.Add("account deletion");
            CapabilityNotice.Text = unavailable.Count > 0 ? "This server version does not support " + string.Join(" or ", unavailable) + "." : "";
            if (client.Truncated) CapabilityNotice.Text += " This backend returns only the first 250 users; pagination needs a backend update.";
            CapabilityNotice.Visibility = CapabilityNotice.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        else
        {
            users = []; selected = null; UserList.ItemsSource = null;
            CloseForm(); ClearPassword(); LoginPassword.Clear();
            AccessEditor.SelectAccount(null, null);
        }
        UpdateButtons();
    }

    private async void Refresh(object sender, RoutedEventArgs e) => await Run(async () => { await LoadUsers(); Notice.Text = "User list refreshed."; });
    private async Task LoadUsers()
    {
        if (client == null) return;
        var selectedId = selected?.Id;
        users = await client.Users(); ShowSession(); ApplyFilter();
        UserList.SelectedItem = users.FirstOrDefault(u => u.Id == selectedId && ((IEnumerable<ManagedUser>?)UserList.ItemsSource)?.Any(item => item.Id == u.Id) == true);
    }

    private async void SignOut(object sender, RoutedEventArgs e)
    {
        await Run(async () =>
        {
            try { if (client != null) await client.SignOut(); Notice.Text = "Signed out. SSH monitoring is independent."; }
            finally { ShowSession(); }
        });
    }

    private void FilterUsers(object sender, TextChangedEventArgs e) { if (UserList != null) ApplyFilter(); }
    private void ApplyFilter()
    {
        string query = Search.Text.Trim();
        var filtered = users.Where(u => u.Username.Contains(query, StringComparison.OrdinalIgnoreCase) || u.Label.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        var selectedId = selected?.Id;
        UserList.ItemsSource = filtered;
        UserList.SelectedItem = filtered.FirstOrDefault(user => user.Id == selectedId);
        UserCount.Text = $"People  ·  {filtered.Count} of {users.Count}";
    }
    private void SelectUser(object sender, SelectionChangedEventArgs e)
    {
        selected = UserList.SelectedItem as ManagedUser;
        SelectedName.Text = selected?.Label ?? "Select an account";
        SelectedDetail.Text = selected?.Detail ?? "Choose a user to manage their access.";
        AccessEditor.SelectAccount(client, selected);
        AccountActions.Visibility = selected == null ? Visibility.Collapsed : Visibility.Visible;
        AccountActions.IsExpanded = false;
        CloseForm(); ClearPassword(); UpdateButtons();
    }
    private void OpenFeatures(object sender, RoutedEventArgs e)
    {
        if (busy || client?.SignedIn != true || !client.FeatureManagement) return;
        new FeatureAdminWindow(client) { Owner = Window.GetWindow(this) }.ShowDialog();
        ShowSession();
        AccessEditor.SelectAccount(client, selected, reload: true);
    }

    private void UpdateButtons()
    {
        bool allowed = !busy && selected != null && !selected.InstanceAdmin && client?.SignedIn == true;
        bool Can(string action) => allowed && client!.Supports(action);
        FeaturesButton.IsEnabled = !busy && client?.SignedIn == true && client.FeatureManagement;
        BanButton.IsEnabled = Can("ban") && !selected!.Banned;
        UnbanButton.IsEnabled = Can("unban") && selected!.Banned;
        RevokeButton.IsEnabled = Can("revoke");
        ResetButton.IsEnabled = Can("resetPassword") && !selected!.Guest;
        SetButton.IsEnabled = Can("setPassword") && !selected!.Guest;
        DeleteButton.IsEnabled = Can("delete");
        SetButton.ToolTip = client?.Supports("setPassword") == true ? "Choose a temporary password for this account" : "This server does not offer chosen passwords.";
        DeleteButton.ToolTip = client?.Supports("delete") == true ? "Delete login and profile; keep messages as Deleted account" : "This server does not offer account deletion.";
    }
    private void Ban(object sender, RoutedEventArgs e) => BeginAction("ban", "Ban account", "This signs out every device and blocks the account from the whole Dorham instance until unbanned.");
    private void Unban(object sender, RoutedEventArgs e) => BeginAction("unban", "Unban account", "This allows a fresh sign-in. Previously revoked sessions stay signed out.");
    private void Revoke(object sender, RoutedEventArgs e) => BeginAction("revoke", "Sign out all devices", "This revokes all current sessions and disconnects the account from voice. The user can sign in again.");
    private void ResetPassword(object sender, RoutedEventArgs e) => BeginAction("resetPassword", "Generate a temporary password", "This replaces the password, invalidates recovery codes and signs out all devices. The user must change the temporary password after signing in. The new password is shown once.");
    private void SetPassword(object sender, RoutedEventArgs e) => BeginAction("setPassword", "Set a temporary password", "This replaces the password, invalidates recovery methods and signs out all devices. The user must choose their own password after signing in.");
    private void DeleteAccount(object sender, RoutedEventArgs e) => BeginAction("delete", "Permanently delete account", "This permanently removes login/profile access and memberships. Existing messages stay under Deleted account. Any servers owned by this account transfer to you. This cannot be undone.");

    private void BeginAction(string action, string title, string detail)
    {
        if (busy || selected == null || selected.InstanceAdmin || client?.Supports(action) != true) return;
        AccountActions.IsExpanded = true;
        CloseForm(); ClearPassword(); pendingAction = action; pendingUser = selected;
        ActionTitle.Text = title + " · @" + selected.Username; ActionDetail.Text = detail;
        PasswordForm.Visibility = action == "setPassword" ? Visibility.Visible : Visibility.Collapsed;
        DeleteForm.Visibility = action == "delete" ? Visibility.Visible : Visibility.Collapsed;
        ConfirmButton.Content = action == "delete" ? "Delete permanently" : "Confirm";
        ActionForm.Visibility = Visibility.Visible;
        if (action == "setPassword") NewPassword.Focus();
        else if (action == "delete") ConfirmUsername.Focus();
        else ConfirmButton.Focus();
        Dispatcher.BeginInvoke(() => DetailScroll.ScrollToEnd(), System.Windows.Threading.DispatcherPriority.ContextIdle);
    }

    private async void ConfirmAction(object sender, RoutedEventArgs e) => await ConfirmSelected();
    private async Task ConfirmSelected()
    {
        if (pendingAction == null || pendingUser == null || busy) return;
        await Run(async () =>
        {
            var action = pendingAction!; var user = pendingUser!;
            string? password = action == "setPassword" ? NewPassword.Password : null;
            if (action == "setPassword" && password != RepeatPassword.Password) throw new InvalidOperationException("The new passwords do not match.");
            // No automatic retries: a timeout can happen after a successful mutation.
            var temporary = await client!.Act(user, action, password, ConfirmUsername.Text);
            CloseForm(); Notice.Text = $"Confirmed: {ActionLabel(action)} for @{user.Username}.";
            if (action == "delete")
            {
                users.RemoveAll(item => item.Id == user.Id);
                ApplyFilter();
            }
            try { await LoadUsers(); }
            catch { Notice.Text += " The user list could not refresh. Refresh before another action."; }
            if (!client.SignedIn) { ShowSession(); Notice.Text += " Sign in again to continue."; }
            if (client.SignedIn && !string.IsNullOrEmpty(temporary))
            {
                temporaryPassword = temporary; PasswordResult.Visibility = Visibility.Visible;
            }
        });
    }
    private static string ActionLabel(string action) => action switch { "ban" => "banned", "unban" => "unbanned", "revoke" => "devices signed out", "setPassword" => "password set", "resetPassword" => "password generated", "delete" => "account deleted", _ => action };
    private void CancelAction(object sender, RoutedEventArgs e) => CloseForm();
    private void CloseForm()
    {
        pendingAction = null; pendingUser = null; ActionForm.Visibility = Visibility.Collapsed;
        NewPassword.Clear(); RepeatPassword.Clear(); ConfirmUsername.Clear();
    }
    private void RevealPassword(object sender, RoutedEventArgs e)
    {
        bool show = GeneratedPassword.Visibility != Visibility.Visible;
        GeneratedPassword.Text = show ? temporaryPassword ?? "" : "";
        GeneratedPassword.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        RevealButton.Content = show ? "Hide" : "Reveal";
    }
    private void DismissPassword(object sender, RoutedEventArgs e) => ClearPassword();
    private void ClearPassword()
    {
        temporaryPassword = null; GeneratedPassword.Clear(); GeneratedPassword.Visibility = Visibility.Collapsed;
        PasswordResult.Visibility = Visibility.Collapsed; RevealButton.Content = "Reveal";
    }
    public void HideSecrets() { CloseForm(); ClearPassword(); LoginPassword.Clear(); AccountActions.IsExpanded = false; }
    private async Task Run(Func<Task> work)
    {
        if (busy) return;
        busy = true; LoginView.IsEnabled = false; UsersView.IsEnabled = false; UpdateButtons();
        Notice.Text = "Working…";
        try { await work(); }
        catch (Exception error)
        {
            Notice.Text = error switch
            {
                AdminApiException or InvalidOperationException => error.Message,
                HttpRequestException or TaskCanceledException => "The connection failed or timed out. An action may have completed. Refresh users and check the account before repeating it.",
                _ => "The server response could not be read. Refresh users and check the account before repeating an action."
            };
            // Require a fresh confirmation after ambiguous failures.
            CloseForm();
            if (client?.SignedIn != true) ShowSession();
        }
        finally { busy = false; LoginView.IsEnabled = true; UsersView.IsEnabled = true; UpdateButtons(); }
    }

    // Offline visual fixture only: no endpoint, session or action is enabled.
    internal void ShowPreview(bool future)
    {
        LoginView.Visibility = Visibility.Collapsed; UsersView.Visibility = Visibility.Visible;
        SessionLabel.Text = "Offline preview · no connection";
        Notice.Text = "Preview with synthetic users. No real account data or requests.";
        CapabilityNotice.Text = future ? "Backend contract preview: chosen passwords and deletion become available after capability discovery." : "Backend update required for chosen passwords and account deletion. Existing supported actions are available after sign-in.";
        users = [new("1", "community_member", "Community member", false, false, false, false), new("2", "banned_member", "Banned member", false, false, true, false), new("3", "guest_visitor", "Guest visitor", false, true, false, false), new("4", "dorham_admin", "Dorham administrator", true, false, false, false)];
        ApplyFilter(); UserList.SelectedIndex = 0;
    }
    internal async Task ExercisePreview(string directory, Action<string> capture)
    {
        void Assert(bool ok, string label) { if (!ok) throw new InvalidOperationException("Admin UI check failed: " + label); }
        client = AdminSelfTest.PreviewClient(); users = await client.SignIn("synthetic_admin", "synthetic-password");
        ShowSession(); ApplyFilter(); UserList.SelectedIndex = 0;
        Assert(BanButton.IsEnabled && SetButton.IsEnabled && DeleteButton.IsEnabled && !UnbanButton.IsEnabled, "capabilities enable only applicable buttons");
        SetPassword(this, new RoutedEventArgs()); await Task.Delay(100); capture(Path.Combine(directory, "admin-set-password.png"));
        NewPassword.Password = "synthetic-chosen-password"; RepeatPassword.Password = "different"; await ConfirmSelected();
        Assert(Notice.Text.Contains("do not match") && ActionForm.Visibility == Visibility.Collapsed, "mismatched passwords rejected");
        DeleteAccount(this, new RoutedEventArgs()); await Task.Delay(100); capture(Path.Combine(directory, "admin-delete-confirmation.png"));
        ConfirmUsername.Text = "wrong-name"; await ConfirmSelected(); Assert(Notice.Text.Contains("exact username"), "delete requires exact username");
        ResetPassword(this, new RoutedEventArgs()); await ConfirmSelected();
        Assert(temporaryPassword == "synthetic-once-password" && GeneratedPassword.Visibility == Visibility.Collapsed, "temporary password starts hidden");
        RevealPassword(this, new RoutedEventArgs()); Assert(GeneratedPassword.Text == "synthetic-once-password", "password revealed explicitly");
        HideSecrets(); Assert(GeneratedPassword.Text == "" && temporaryPassword == null && NewPassword.Password == "", "navigation clears secrets");
        Search.Text = "Member 250"; Assert(UserList.Items.Count == 1, "search filters users");
        await client.SignOut(); ShowSession(); Assert(LoginView.Visibility == Visibility.Visible && users.Count == 0, "signout clears user data");
        File.WriteAllText(Path.Combine(directory, "admin-interaction-checks.json"), System.Text.Json.JsonSerializer.Serialize(new { status = "passed", offlineSyntheticTransport = true, capabilities = true, passwordConfirmation = true, deleteConfirmation = true, generatedPassword = true, secretClearing = true, search = true, signOut = true }));
    }
    internal async Task VerifyFeatureAccess(Action? capture = null)
    {
        using var fixture = AdminSelfTest.PreviewClient();
        client = fixture;
        users = await fixture.SignIn("synthetic_admin", "synthetic-password");
        ShowSession(); ApplyFilter(); UserList.SelectedIndex = 1; Notice.Text = "";
        try
        {
            await AccessEditor.Loading;
            if (selected?.Id != "user-1" || AccountActions.IsExpanded ||
                AccessEditor.FindName("RankPicker") is not ListBox { SelectedItem: "Pro", Items.Count: 5 } ||
                AccessEditor.FindName("FeatureRows") is not StackPanel { Children.Count: 6 } rows ||
                !rows.Children.OfType<Border>().SelectMany(row => ((DockPanel)row.Child).Children.OfType<Button>())
                    .Any(button => System.Windows.Automation.AutomationProperties.GetName(button) == "Remove TTS Plus") ||
                !rows.Children.OfType<Border>().SelectMany(row => ((DockPanel)row.Child).Children.OfType<Button>())
                    .Any(button => button.Content as string == "Enable AI voice"))
                throw new InvalidOperationException("The selected account's rank and individual feature grants were not loaded.");
            capture?.Invoke();
            var tools = new FeatureAdminWindow(fixture);
            try { await tools.VerifyNavigation(); }
            finally { tools.Close(); }
        }
        finally { AccessEditor.SelectAccount(null, null); client = null; }
    }
    public void CloseSession()
    {
        HideSecrets();
        // Best effort current-session logout on app close. Never block window shutdown.
        var current = client; client = null;
        if (current != null) _ = Task.Run(async () => { try { await current.SignOut(); } catch { } finally { current.Dispose(); } });
    }
}
