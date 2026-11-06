using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Dorham.Monitor;

public sealed record ManagedUser(string Id, string Username, string DisplayName, bool InstanceAdmin, bool Guest, bool Banned, bool MustChangePassword)
{
    public string Label => string.IsNullOrWhiteSpace(DisplayName) ? Username : DisplayName;
    public string Detail => $"@{Username}  ·  " + (InstanceAdmin ? "Administrator · protected" : Banned ? "Banned" : Guest ? "Guest" : "Active") + (MustChangePassword ? " · password change required" : "");
}

public sealed class AdminApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

// Independent from SSH monitoring. No credentials/tokens are written to disk.
public sealed class AdminClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    private readonly HttpClient http;
    private string? token;
    private readonly HashSet<string> actions = [];
    public bool FeatureManagement { get; private set; }
    public bool SignedIn => token != null;
    public string AdministratorName { get; private set; } = "";
    public bool Paginated { get; private set; }
    public bool Truncated { get; private set; }
    public bool KeepsDeletedMessages { get; private set; }
    public bool Supports(string action) => SignedIn && actions.Contains(action) && (action != "delete" || KeepsDeletedMessages);

    public AdminClient(string endpoint, HttpMessageHandler? handler = null)
    {
        if (!Uri.TryCreate(endpoint.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo) || uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidOperationException("Enter the HTTPS address of your Dorham instance, for example https://dorhamapp.ir.");
        http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        {
            BaseAddress = uri, Timeout = TimeSpan.FromSeconds(20)
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"Dorham-Monitor/{typeof(AdminClient).Assembly.GetName().Version?.ToString(3)}");
    }

    public async Task<List<ManagedUser>> SignIn(string username, string password)
    {
        try
        {
            using var result = await Send(HttpMethod.Post, "auth/login", new { username = username.Trim(), password, requestId = Guid.NewGuid().ToString() }, native: true);
            if (!result.RootElement.TryGetProperty("accessToken", out var access) || string.IsNullOrEmpty(access.GetString())) throw new InvalidOperationException("The server did not return an administrator session.");
            token = access.GetString();
            var user = result.RootElement.GetProperty("user").Deserialize<ManagedUser>(Json)!;
            if (!user.InstanceAdmin || user.Guest || user.Banned || user.MustChangePassword)
                throw new InvalidOperationException("Sign in with a global administrator account whose password change is complete.");
            AdministratorName = user.Label;
            // Server-side authorization is mandatory even when the login response says admin.
            var users = await UsersPage(0);
            try
            {
                using var caps = await Send(HttpMethod.Get, "admin/capabilities");
                var root = caps.RootElement;
                if (!root.TryGetProperty("version", out var version) || version.GetInt32() != 1) throw new InvalidOperationException("This server uses an unsupported admin API version.");
                foreach (var action in root.GetProperty("userActions").EnumerateArray()) if (action.GetString() is { } name) actions.Add(name);
                FeatureManagement = root.TryGetProperty("featureManagement", out var features) && features.ValueKind == JsonValueKind.True;
                Paginated = root.TryGetProperty("usersPagination", out var pages) && pages.ValueKind == JsonValueKind.True;
                KeepsDeletedMessages = root.TryGetProperty("deletionMode", out var mode) && mode.GetString() == "anonymizeKeepMessages";
            }
            catch (AdminApiException error) when (error.Status == HttpStatusCode.NotFound)
            {
                actions.UnionWith(["ban", "unban", "revoke", "resetPassword"]);
            }
            return await RemainingUsers(users);
        }
        catch
        {
            try { await SignOut(); } catch { ClearSession(); }
            throw;
        }
    }

    private async Task<List<ManagedUser>> UsersPage(int offset)
    {
        using var doc = await Send(HttpMethod.Get, "admin/users?offset=" + offset.ToString(CultureInfo.InvariantCulture));
        return doc.RootElement.GetProperty("users").Deserialize<List<ManagedUser>>(Json) ?? [];
    }

    private async Task<List<ManagedUser>> RemainingUsers(List<ManagedUser> users)
    {
        Truncated = !Paginated && users.Count >= 250;
        if (!Paginated) return users;
        var seen = users.Select(user => user.Id).ToHashSet(StringComparer.Ordinal);
        int pageSize = users.Count;
        for (int offset = 250; pageSize == 250; offset += 250)
        {
            if (offset > 1000000) throw new InvalidOperationException("The user list exceeded the supported pagination limit.");
            var page = await UsersPage(offset); pageSize = page.Count;
            // Detect servers that advertise pagination but ignore the offset.
            if (page.Any(user => !seen.Add(user.Id))) throw new InvalidOperationException("The user list changed during paging. Refresh users and try again.");
            users.AddRange(page);
        }
        return users;
    }

    public async Task<List<ManagedUser>> Users() => await RemainingUsers(await UsersPage(0));

    public async Task<string?> Act(ManagedUser user, string action, string? password = null, string? confirmation = null)
    {
        if (user.InstanceAdmin) throw new InvalidOperationException("Administrator accounts are protected.");
        if (!Supports(action)) throw new InvalidOperationException("This action needs a backend update. See BACKEND-HANDOFF.md.");
        if (action is "setPassword" or "resetPassword" && user.Guest) throw new InvalidOperationException("Guest accounts do not have passwords.");
        if (action == "setPassword" && (password == null || password.Length is < 8 or > 128)) throw new InvalidOperationException("Use a password with 8–128 characters.");
        if (action == "delete" && confirmation != user.Username) throw new InvalidOperationException("Type the exact username to confirm deletion.");
        var body = new Dictionary<string, object> { ["action"] = action, ["requestId"] = Guid.NewGuid().ToString() };
        if (action == "setPassword") body["password"] = password!;
        if (action == "delete") body["confirmUsername"] = confirmation!;
        using var result = await Send(HttpMethod.Post, "admin/users/" + Uri.EscapeDataString(user.Id), body);
        if (!result.RootElement.TryGetProperty("success", out var success) || success.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("The server did not confirm the action. Refresh users before trying again.");
        var temporary = result.RootElement.TryGetProperty("temporaryPassword", out var issued) ? issued.GetString() : null;
        if (action == "resetPassword" && string.IsNullOrEmpty(temporary)) throw new InvalidOperationException("The password may have been reset, but the server did not return it. Check the account before issuing another reset.");
        return temporary;
    }

    public Task<JsonDocument> FeatureRequest(HttpMethod method, string path, object? body = null)
    {
        if (!SignedIn || !FeatureManagement) throw new InvalidOperationException("Feature management is unavailable.");
        return Send(method, "admin/" + path, body);
    }

    public async Task<JsonDocument> UploadCatalog(string file, string label, string kind, string access, string? community, string? slot, string? pack)
    {
        using var stream = System.IO.File.OpenRead(file);
        if (stream.Length > 500 * 1024) throw new InvalidOperationException("Choose a file smaller than 500 KiB.");
        using var content = new MultipartFormDataContent();
        content.Add(new StreamContent(stream), "file", System.IO.Path.GetFileName(file));
        content.Add(new StringContent(label), "label");
        content.Add(new StringContent(kind), "kind");
        content.Add(new StringContent(access), "access");
        if (!string.IsNullOrWhiteSpace(pack)) content.Add(new StringContent(pack), "pack");
        if (!string.IsNullOrWhiteSpace(community)) content.Add(new StringContent(community), "serverId");
        if (!string.IsNullOrWhiteSpace(slot)) content.Add(new StringContent(slot), "freeSlot");
        return await FeatureRequest(HttpMethod.Post, "features/catalog", content);
    }

    private async Task<JsonDocument> Send(HttpMethod method, string path, object? body = null, bool native = false)
    {
        using var request = new HttpRequestMessage(method, "api/v1/" + path);
        if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (native) request.Headers.Add("X-Dorham-Native", "1");
        if (body != null) request.Content = body as HttpContent ?? JsonContent.Create(body);
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized) ClearSession();
            // Translate recognized codes locally so an error cannot echo credentials.
            string? code = null;
            try
            {
                using var error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                if (error.RootElement.ValueKind == JsonValueKind.Object &&
                    error.RootElement.TryGetProperty("error", out var detail) && detail.ValueKind == JsonValueKind.Object &&
                    detail.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String)
                    code = value.GetString();
            }
            catch (JsonException) { }
            string message = code switch
            {
                "ACCOUNT_DELETED" => "This account was already deleted. Refresh the user list.",
                "CONFIRMATION_REQUIRED" => "The username has changed. Refresh users and confirm the current username.",
                "GUEST_ACCOUNT" => "Guest accounts do not have passwords.",
                "ALREADY_APPLIED" => "The server already applied this request. Refresh the user list.",
                "PASSWORD_CHANGE_REQUIRED" => "Change your temporary password in Dorham before signing in to Monitor.",
                "SPEECH_PROVIDER_REGION" => "The speech provider refused requests from this server's region.",
                "SPEECH_PROVIDER_AUTH" => "The speech provider refused authorization for the server credential.",
                "SPEECH_PROVIDER_QUOTA" => "The speech provider reported a quota or rate limit.",
                "SPEECH_PROVIDER_UNAVAILABLE" => "Enable the speech provider under Server tools before granting the AI voice.",
                "SPEECH_PREVIEW_TEXT_CHANGED" => "The provider's transcript differed from the preview text. Try a shorter sample or another voice.",
                "SPEECH_PREVIEW_FAILED" => "The speech provider could not generate a preview. Check the provider connection and server credential.",
                _ when response.StatusCode == HttpStatusCode.BadRequest && path is ("admin/features/speech/preview" or "admin/features/settings/speech")
                    => "The server rejected the speech settings. Check that the endpoint is approved on the server, and check the model, voice, timeout and character limits.",
                _ => StatusMessage(response.StatusCode)
            };
            throw new AdminApiException(response.StatusCode, message);
        }
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    }

    private static string StatusMessage(HttpStatusCode status) => status switch
    {
        HttpStatusCode.Unauthorized => "Sign-in was refused or the session expired. Sign in again.",
        HttpStatusCode.Forbidden => "The server refused this operation. Check administrator access and account protections.",
        HttpStatusCode.NotFound => "This admin endpoint is unavailable on the server.",
        HttpStatusCode.BadRequest => "The server rejected the input. Check the password or confirmation.",
        HttpStatusCode.Conflict => "The account changed or this request was already applied. Refresh the user list before continuing.",
        HttpStatusCode.TooManyRequests => "Too many requests. Wait before trying again.",
        _ => "The server could not confirm the request. Refresh users and check the account before repeating an action."
    };

    public async Task SignOut()
    {
        try { if (token != null) { using var result = await Send(HttpMethod.Post, "auth/logout", new { requestId = Guid.NewGuid().ToString() }); } }
        finally { ClearSession(); }
    }
    public void ClearSession() { token = null; actions.Clear(); AdministratorName = ""; Paginated = false; FeatureManagement = false; Truncated = false; KeepsDeletedMessages = false; }
    public void Dispose() { ClearSession(); http.Dispose(); }
}
